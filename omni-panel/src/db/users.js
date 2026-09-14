import { batch } from "./index.js";
import { conflict, notFound, badRequest } from "../core/errors.js";
import { isExampleUpstream } from "../proxy/upstream.js";

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

export function newUserInput(raw, E) {
  const username = String(raw.username || "").trim();
  if (!USERNAME_RE.test(username)) {
    throw badRequest("نام کاربری باید ۳ تا ۳۲ حرف انگلیسی/عدد/._- باشد", { username });
  }
  const quota = Number(raw.quota_gb ?? E.config.defaultQuotaGb);
  const days = Number(raw.expiry_days ?? E.config.defaultExpiryDays);
  if (!Number.isFinite(quota) || quota <= 0) throw badRequest("حجم نامعتبر است");
  if (!Number.isFinite(days) || days <= 0) throw badRequest("مدت نامعتبر است");
  const now = Date.now();
  return {
    username,
    uuid: raw.uuid || crypto.randomUUID(),
    sub_token: raw.sub_token || crypto.randomUUID().replaceAll("-", ""),
    quota_gb: quota,
    used_bytes: Number(raw.used_bytes || 0),
    expiry_days: days,
    first_connect: raw.first_connect === false ? 0 : 1,
    activated_at: null,
    expires_at: raw.first_connect === false ? now + days * 86400000 : null,
    device_limit: Math.max(1, Number(raw.device_limit || 3)),
    request_limit: Math.max(0, Number(raw.request_limit || 0)),
    requests_used: 0,
    ips: JSON.stringify(normaliseList(raw.ips)),
    proxies: JSON.stringify(assertRealProxies(normaliseList(raw.proxies))),
    connection: String(raw.connection || "ws"),
    tls: raw.tls === "off" ? "off" : "on",
    fragment: String(raw.fragment || ""),
    fingerprint: String(raw.fingerprint || ""),
    block_list: JSON.stringify(normaliseList(raw.block_list)),
    is_active: raw.is_active === false ? 0 : 1,
    created_by: raw.created_by || null,
    note: String(raw.note || "").slice(0, 500),
    created_at: now,
    updated_at: now,
  };
}

function assertRealProxies(list) {
  for (const spec of list) {
    if (isExampleUpstream(spec)) {
      throw badRequest("«user:pass@1.2.3.4:1080» آدرسِ مثالِ داخل فرم است، نه یک پروکسی واقعی. این فیلد را خالی بگذارید یا آدرس واقعی بدهید — وگرنه همه‌ی اتصال‌ها با «تونل باز، بالادست خاموش» قرمز می‌شوند.", { proxies: spec });
    }
  }
  return list;
}

function normaliseList(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[\n,]/);
  return [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))].slice(0, 32);
}

const COLS = [
  "username","uuid","sub_token","quota_gb","used_bytes","expiry_days","first_connect",
  "activated_at","expires_at","device_limit","request_limit","requests_used","ips","proxies",
  "connection","tls","fragment","fingerprint","block_list","is_active","created_by","note",
  "created_at","updated_at",
];

export async function createUser(E, input) {
  const sql = `INSERT INTO users (${COLS.join(",")}) VALUES (${COLS.map(() => "?").join(",")})`;
  try {
    await E.db.prepare(sql).bind(...COLS.map((c) => input[c] ?? null)).run();
  } catch (e) {
    if (String(e?.message || e).includes("UNIQUE")) throw conflict(`کاربر «${input.username}» از قبل وجود دارد`);
    throw e;
  }
  return getUser(E, input.username);
}

export async function getUser(E, username) {
  const row = await E.db.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
  if (!row) throw notFound("user");
  return hydrate(row);
}

export async function getUserByUuid(E, uuid) {
  const row = await E.db.prepare("SELECT * FROM users WHERE uuid = ?").bind(uuid).first();
  return row ? hydrate(row) : null;
}

export async function getUserBySubToken(E, token) {
  const row = await E.db.prepare("SELECT * FROM users WHERE sub_token = ?").bind(token).first();
  return row ? hydrate(row) : null;
}

/** One JSON row for the dashboard. Parsing happens once, in one place. */
export function hydrate(row) {
  const now = Date.now();
  const safe = (s, f) => {
    try { return JSON.parse(s || ""); } catch { return f; }
  };
  const quotaBytes = Math.round(row.quota_gb * 1024 ** 3);
  const expired = row.expires_at != null && row.expires_at <= now;
  const over = row.used_bytes >= quotaBytes;
  return {
    ...row,
    ips: safe(row.ips, []),
    proxies: safe(row.proxies, []),
    block_list: safe(row.block_list, []),
    is_active: !!row.is_active,
    first_connect: !!row.first_connect,
    quota_bytes: quotaBytes,
    used_pct: quotaBytes ? Math.min(100, Math.round((row.used_bytes / quotaBytes) * 1000) / 10) : 0,
    status: !row.is_active ? "disabled" : expired ? "expired" : over ? "exhausted" : "active",
    ms_left: row.expires_at ? Math.max(0, row.expires_at - now) : null,
  };
}

export async function listUsers(E, { q = "", status = "all", sort = "created_at", dir = "desc", page = 1, size = 50 } = {}) {
  const where = [];
  const bind = [];
  if (q) {
    where.push("(username LIKE ? OR note LIKE ? OR uuid LIKE ?)");
    const like = `%${q}%`;
    bind.push(like, like, like);
  }
  if (status === "active") where.push("is_active = 1");
  if (status === "disabled") where.push("is_active = 0");
  if (status === "expired") {
    where.push("expires_at IS NOT NULL AND expires_at <= ?");
    bind.push(Date.now());
  }
  const allowedSort = new Set(["created_at", "username", "used_bytes", "expires_at", "last_active"]);
  const s = allowedSort.has(sort) ? sort : "created_at";
  const d = dir === "asc" ? "ASC" : "DESC";
  const offset = (Math.max(1, Number(page)) - 1) * size;
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows, cnt] = await batch(E, [
    E.db.prepare(`SELECT * FROM users ${w} ORDER BY ${s} ${d} LIMIT ? OFFSET ?`).bind(...bind, size, offset),
    E.db.prepare(`SELECT COUNT(*) AS n FROM users ${w}`).bind(...bind),
  ]);
  return {
    users: (rows.results || []).map(hydrate),
    total: cnt.results?.[0]?.n ?? 0,
    page: Number(page),
    size,
  };
}

const PATCHABLE = new Set([
  "quota_gb","expiry_days","device_limit","request_limit","connection","tls","fragment",
  "fingerprint","note","is_active","first_connect","ips","proxies","block_list",
]);

export async function updateUser(E, username, patch) {
  const sets = [];
  const bind = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!PATCHABLE.has(k)) continue;
    if (["ips", "proxies", "block_list"].includes(k)) {
      sets.push(`${k} = ?`);
      bind.push(JSON.stringify(k === "proxies" ? assertRealProxies(normaliseList(v)) : normaliseList(v)));
      continue;
    }
    if (k === "is_active") {
      sets.push("is_active = ?");
      bind.push(v ? 1 : 0);
      continue;
    }
    sets.push(`${k} = ?`);
    bind.push(v);
  }
  if (patch.expiry_days != null) {
    // Extending a user recomputes the deadline from now (or from the existing
    // activation), which is what an admin actually means by "30 days".
    sets.push("expires_at = ?");
    bind.push(Date.now() + Number(patch.expiry_days) * 86400000);
  }
  if (!sets.length) return getUser(E, username);
  sets.push("updated_at = ?");
  bind.push(Date.now());
  const res = await E.db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE username = ?`).bind(...bind, username).run();
  if (!res.meta.changes) throw notFound("user");
  return getUser(E, username);
}

export async function deleteUser(E, username) {
  const res = await E.db.prepare("DELETE FROM users WHERE username = ?").bind(username).run();
  if (!res.meta.changes) throw notFound("user");
}

/**
 * Bulk operations as a single D1 batch.
 * Zeus loops and awaits per user — for 200 users that's 200 round-trips and a
 * real chance of hitting the 100k daily row limit mid-operation.
 */
export async function bulk(E, usernames, op, value = null) {
  if (!usernames?.length) throw badRequest("هیچ کاربری انتخاب نشده");
  const ph = usernames.map(() => "?").join(",");
  const statements = [];
  switch (op) {
    case "enable":
      statements.push(E.db.prepare(`UPDATE users SET is_active=1, updated_at=? WHERE username IN (${ph})`).bind(Date.now(), ...usernames));
      break;
    case "disable":
      statements.push(E.db.prepare(`UPDATE users SET is_active=0, updated_at=? WHERE username IN (${ph})`).bind(Date.now(), ...usernames));
      break;
    case "delete":
      statements.push(E.db.prepare(`DELETE FROM users WHERE username IN (${ph})`).bind(...usernames));
      break;
    case "reset_traffic":
      statements.push(E.db.prepare(`UPDATE users SET used_bytes=0, updated_at=? WHERE username IN (${ph})`).bind(Date.now(), ...usernames));
      break;
    case "reset_requests":
      statements.push(E.db.prepare(`UPDATE users SET requests_used=0, updated_at=? WHERE username IN (${ph})`).bind(Date.now(), ...usernames));
      break;
    case "extend": {
      const ms = Number(value) * 86400000;
      statements.push(
        E.db.prepare(
          `UPDATE users SET expires_at = COALESCE(expires_at, ?) + ?, expiry_days = expiry_days + ?, updated_at = ? WHERE username IN (${ph})`,
        ).bind(Date.now(), ms, Number(value), Date.now(), ...usernames),
      );
      break;
    }
    default:
      throw badRequest(`عملیات ناشناخته: ${op}`);
  }
  await batch(E, statements);
  return { affected: usernames.length, op };
}

/** Aggregate counters for the dashboard header — one query, not N. */
export async function userStats(E) {
  const { results } = await E.db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(is_active) AS active,
              SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 1 ELSE 0 END) AS expired,
              SUM(used_bytes) AS used_bytes,
              SUM(requests_used) AS requests
       FROM users`,
    )
    .bind(Date.now())
    .all();
  const r = results?.[0] || {};
  return {
    total: r.total || 0,
    active: r.active || 0,
    expired: r.expired || 0,
    used_bytes: r.used_bytes || 0,
    requests: r.requests || 0,
  };
}

export async function rotateSubToken(E, username) {
  const token = crypto.randomUUID().replaceAll("-", "");
  await E.db.prepare("UPDATE users SET sub_token=?, updated_at=? WHERE username=?").bind(token, Date.now(), username).run();
  return token;
}

export async function rotateUuid(E, username) {
  const uuid = crypto.randomUUID();
  await E.db.prepare("UPDATE users SET uuid=?, updated_at=? WHERE username=?").bind(uuid, Date.now(), username).run();
  return uuid;
}
