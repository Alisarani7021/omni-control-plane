import { ok, json, readJson } from "../core/http.js";
import { Settings, audit } from "../db/index.js";
import * as Users from "../db/users.js";
import { redactSettings } from "../core/keys.js";

/**
 * Dashboard stats in ONE request.
 *
 * Zeus's panel fires 10+ separate `/api/*` calls on load and recomputes
 * aggregates in the browser from the full user list — which means the whole
 * table is transferred to the client on every page view.
 */
export async function overview(request, E) {
  const S = new Settings(E);
  // Imported, not re-exported through api/diag.js: a re-export of the same
  // symbol from two modules makes the bundler rename one of them, and the
  // renamed binding is in TDZ when this handler runs ("Cannot access
  // 'cfUsage2' before initialization").
  const [userStats, usage, daily, topUsers] = await Promise.all([
    Users.userStats(E),
    cfUsage(E),
    usageSeries(E, Number(new URL(request.url).searchParams.get("days") || 7)),
    topConsumers(E, 8),
  ]);
  return ok({
    users: userStats,
    cloudflare: usage,
    series: daily,
    top: topUsers,
    settings: {
      panelName: await S.get("panel_name", E.config.panelName),
      publicHost: await S.get("public_host"),
      port: Number((await S.get("port")) || 443),
      fragmentPreset: await S.get("fragment_preset", E.config.fragmentPreset),
      cleanIps: JSON.parse((await S.get("clean_ips")) || "[]"),
      autoRotate: (await S.get("auto_rotate")) === "1",
      rotateMinutes: Number((await S.get("rotate_minutes")) || 30),
      muxEnabled: (await S.get("mux_enabled")) === "1",
      blockNsfw: (await S.get("block_nsfw")) === "1",
    },
  });
}

/**
 * Cloudflare Worker request budget.
 *
 * Reading this matters: exceeding the free-tier limit gets the account banned,
 * not just throttled. Zeus polls the Analytics GraphQL API from the browser.
 * Kaveh reads it server-side, caches it for 60 s, and returns a percentage so
 * the UI can show a warning before you hit the wall.
 */
export async function cfUsage(E) {
  const cached = cfUsageCache.get("v");
  if (cached && cached.exp > Date.now()) return cached.value;
  const accountId = E.raw?.CF_ACCOUNT_ID;
  const token = E.raw?.CF_API_TOKEN;
  if (!accountId || !token) {
    return { available: false, reason: "CF_ACCOUNT_ID / CF_API_TOKEN تنظیم نشده" };
  }
  try {
    const query = `{
      viewer {
        zones(filter: { zoneTag: "${accountId}" }) { __typename }
      }
    }`;
    const res = await fetch("https://api.cloudflare.com/client/v4/accounts/" + accountId + "/workers/usage", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { available: false, reason: `cloudflare ${res.status}` };
    const j = await res.json();
    const value = {
      available: true,
      total: j?.result?.total ?? null,
      daily: j?.result?.daily ?? null,
      limit: 100_000,
      pct: j?.result?.daily ? Math.round((j.result.daily / 100000) * 1000) / 10 : null,
    };
    cfUsageCache.set("v", { value, exp: Date.now() + 60_000 });
    return value;
  } catch (e) {
    return { available: false, reason: String(e?.message || e) };
  }
}
const cfUsageCache = new Map();

export async function usageSeries(E, days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const { results } = await E.db
    .prepare(
      `SELECT day, SUM(up_bytes) AS up, SUM(down_bytes) AS down, SUM(conns) AS conns
       FROM usage_daily WHERE day >= ? GROUP BY day ORDER BY day ASC`,
    )
    .bind(since)
    .all();
  return (results || []).map((r) => ({ day: r.day, up: r.up || 0, down: r.down || 0, total: (r.up || 0) + (r.down || 0), conns: r.conns || 0 }));
}

export async function topConsumers(E, limit = 10) {
  const { results } = await E.db.prepare("SELECT username, used_bytes, quota_gb, requests_used FROM users ORDER BY used_bytes DESC LIMIT ?").bind(limit).all();
  return results || [];
}

export async function userUsage(request, E, ctx) {
  const username = ctx.url.searchParams.get("username");
  const days = Number(ctx.url.searchParams.get("days") || 14);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const { results } = await E.db
    .prepare("SELECT day, up_bytes, down_bytes, conns FROM usage_daily WHERE username = ? AND day >= ? ORDER BY day ASC")
    .bind(username, since)
    .all();
  return ok({ username, days, series: results || [] });
}

export async function getSettings(request, E) {
  const S = new Settings(E);
  const all = await S.all();
  // Never leak secrets to the browser, even to an authenticated admin.
  return ok({ settings: redactSettings(all) });
}

export async function putSettings(request, E, ctx) {
  const body = await readJson(request);
  const allowed = new Set([
    "panel_name","public_host","port","fragment_preset","fingerprint","clean_ips","auto_rotate",
    "rotate_minutes","mux_enabled","block_nsfw","block_ads","remark_prefix","sub_prefix",
    "default_quota_gb","default_expiry_days","status_page_enabled","maintenance",
  ]);
  const patch = {};
  for (const [k, v] of Object.entries(body)) {
    if (!allowed.has(k)) continue;
    patch[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  const S = new Settings(E);
  const settings = await S.set(patch);
  await audit(E, { actor: ctx.session?.subject, action: "settings.update", ip: ctx.ip, detail: { keys: Object.keys(patch) } });
  return ok({ settings });
}

/** Full JSON export — for migration off Cloudflare, or onto another account. */
export async function exportBackup(request, E, ctx) {
  const [users, settings, plans, nodes] = await Promise.all([
    E.db.prepare("SELECT * FROM users").all(),
    E.db.prepare("SELECT * FROM settings WHERE key NOT LIKE '%hash%'").all(),
    E.db.prepare("SELECT * FROM plans").all(),
    E.db.prepare("SELECT * FROM nodes").all(),
  ]);
  await audit(E, { actor: ctx.session?.subject, action: "backup.export", ip: ctx.ip });
  const payload = {
    format: "kaveh-backup",
    version: 1,
    exported_at: new Date().toISOString(),
    users: users.results || [],
    settings: settings.results || [],
    plans: plans.results || [],
    nodes: nodes.results || [],
  };
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="kaveh-backup-${Date.now()}.json"`,
    },
  });
}

export async function importBackup(request, E, ctx) {
  const body = await readJson(request);
  if (body.format !== "kaveh-backup") throw new Error("فرمت بک‌آپ نامعتبر است");
  const mode = body.mode === "merge" ? "merge" : "replace";
  if (mode === "replace") {
    await E.db.batch([E.db.prepare("DELETE FROM users"), E.db.prepare("DELETE FROM usage_daily")]);
  }
  const statements = (body.users || []).map((u) =>
    E.db
      .prepare(
        `INSERT INTO users (username,uuid,sub_token,quota_gb,used_bytes,expiry_days,first_connect,activated_at,expires_at,
          device_limit,request_limit,requests_used,ips,proxies,connection,tls,fragment,fingerprint,block_list,is_active,note,created_at,updated_at)
         VALUES (@username,@uuid,@sub_token,@quota_gb,@used_bytes,@expiry_days,@first_connect,@activated_at,@expires_at,
          @device_limit,@request_limit,@requests_used,@ips,@proxies,@connection,@tls,@fragment,@fingerprint,@block_list,@is_active,@note,@created_at,@updated_at)
         ON CONFLICT(username) DO UPDATE SET
           uuid=excluded.uuid, sub_token=excluded.sub_token, quota_gb=excluded.quota_gb, used_bytes=excluded.used_bytes,
           expiry_days=excluded.expiry_days, expires_at=excluded.expires_at, is_active=excluded.is_active`,
      )
      .bind({
        username: u.username, uuid: u.uuid, sub_token: u.sub_token ?? crypto.randomUUID().replaceAll("-", ""),
        quota_gb: u.quota_gb ?? 50, used_bytes: u.used_bytes ?? 0, expiry_days: u.expiry_days ?? 30,
        first_connect: u.first_connect ?? 1, activated_at: u.activated_at ?? null, expires_at: u.expires_at ?? null,
        device_limit: u.device_limit ?? 3, request_limit: u.request_limit ?? 0, requests_used: u.requests_used ?? 0,
        ips: u.ips ?? "[]", proxies: u.proxies ?? "[]", connection: u.connection ?? "ws", tls: u.tls ?? "on",
        fragment: u.fragment ?? "", fingerprint: u.fingerprint ?? "", block_list: u.block_list ?? "[]",
        is_active: u.is_active ?? 1, note: u.note ?? "", created_at: u.created_at ?? Date.now(), updated_at: Date.now(),
      }),
  );
  for (let i = 0; i < statements.length; i += 100) await E.db.batch(statements.slice(i, i + 100));
  await audit(E, { actor: ctx.session?.subject, action: "backup.import", ip: ctx.ip, detail: { mode, n: statements.length } });
  return ok({ imported: statements.length, mode });
}
