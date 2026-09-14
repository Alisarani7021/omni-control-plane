/**
 * Local UI dev server + mock API.
 *
 * Lets you build and demo the whole panel without a Cloudflare account:
 *   npm run ui   →   http://localhost:5173
 *
 * It implements exactly the same JSON contract as the Worker (src/api/*), so
 * the frontend does not know or care which one it is talking to. When a route
 * is added to the Worker, add it here too — `npm run lint:contract` fails the
 * build if the two drift apart.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const UI = join(ROOT, "ui");
const PORT = Number(process.env.PORT || 5173);
const HOST = "0.0.0.0";

/* ══════════════ mock state ══════════════ */
const now = Date.now();
const DAY = 86400000;
const GB = 1024 ** 3;

const NAMES = ["ali", "sara", "reza", "maryam", "hossein", "zahra", "amir", "narges", "mehdi", "fateme",
  "saeed", "leila", "omid", "shirin", "kaveh", "dana", "arash", "roja", "behnam", "sanaz",
  "farhad", "ghazal", "hamid", "yasmin", "iman", "taraneh", "javad", "elham", "kian", "mehrane",
  "navid", "parisa", "ramin", "setare", "taha", "vida", "yaser", "ziba", "babak", "catayoun"];

const IPS = ["104.16.0.0", "104.17.0.0", "104.18.0.0", "172.66.0.0", "188.114.96.0", "104.20.0.0", "172.67.0.0", "141.101.120.0"];
const PRESETS = ["", "mci", "irancell", "rightel", "tci", "aggressive"];
const FPS = ["", "chrome", "safari", "ios", "android", "randomized"];

function rnd(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}
const R = rnd(20260913);

const users = NAMES.map((name, i) => {
  const quota = [10, 25, 50, 100, 200][Math.floor(R() * 5)];
  const usedPct = Math.pow(R(), 1.6);              // most users sit well under quota
  const days = [7, 14, 30, 60, 90][Math.floor(R() * 5)];
  const createdAt = now - Math.floor(R() * 120) * DAY;
  const active = R() > 0.08;
  const firstConnect = R() > 0.5;
  // Realistic spread: ~70% healthy, ~12% expiring within 2 days, ~10% expired,
  // ~8% never connected yet (first-connect clock still waiting).
  const roll = R();
  let expiresAt;
  if (!firstConnect) expiresAt = null;
  else if (roll < 0.7) expiresAt = now + Math.floor((2 + R() * days) * DAY);
  else if (roll < 0.82) expiresAt = now + Math.floor(R() * 2 * DAY);
  else expiresAt = now - Math.floor((1 + R() * 6) * DAY);
  return {
    id: i + 1,
    username: `${name}-${100 + i}`,
    uuid: crypto.randomUUID(),
    sub_token: hex(32),
    quota_gb: quota,
    used_bytes: Math.floor(quota * GB * Math.min(1.02, usedPct)),
    expiry_days: days,
    first_connect: firstConnect ? 1 : 0,
    activated_at: expiresAt ? createdAt + DAY : null,
    expires_at: expiresAt,
    device_limit: [1, 2, 3, 5][Math.floor(R() * 4)],
    request_limit: 0,
    requests_used: Math.floor(R() * 4000),
    ips: JSON.stringify(IPS.slice(0, 1 + Math.floor(R() * 3))),
    proxies: JSON.stringify(R() > 0.85 ? [`vip${i}:${hex(8)}@45.${Math.floor(R() * 200)}.${Math.floor(R() * 200)}.11:1080`] : []),
    connection: "ws",
    tls: "on",
    fragment: PRESETS[Math.floor(R() * PRESETS.length)],
    fingerprint: FPS[Math.floor(R() * FPS.length)],
    block_list: JSON.stringify(R() > 0.9 ? ["ads.example.com"] : []),
    is_active: active ? 1 : 0,
    created_by: "admin",
    note: R() > 0.75 ? ["مشتری تلگرام", "دوست", "VIP", "تست", ""][Math.floor(R() * 5)] : "",
    created_at: createdAt,
    updated_at: createdAt + Math.floor(R() * 10) * DAY,
  };
});

function hex(n) {
  let s = "";
  const c = "0123456789abcdef";
  for (let i = 0; i < n; i++) s += c[Math.floor(R() * 16)];
  return s;
}

const settings = {
  schema_version: "1",
  panel_name: "Kaveh",
  public_host: "kaveh.example.workers.dev",
  port: "443",
  fragment_preset: "mci",
  fingerprint: "chrome",
  clean_ips: JSON.stringify(IPS.slice(0, 4)),
  ip_pool: JSON.stringify(IPS),
  auto_rotate: "1",
  rotate_minutes: "30",
  mux_enabled: "0",
  block_nsfw: "1",
  block_ads: "1",
  remark_prefix: "Kaveh",
  default_quota_gb: "50",
  default_expiry_days: "30",
  status_page_enabled: "1",
  maintenance: "0",
  on_expiry: "disable",
};

const series = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(now - (6 - i) * DAY).toISOString().slice(0, 10);
  const base = 18 + Math.sin(i / 1.7) * 7 + R() * 9;
  return { day: d, down: Math.floor(base * GB), up: Math.floor(base * GB * 0.11), conns: Math.floor(base * 240) };
});

const usageByUsername = Object.fromEntries(
  users.map((u) => [u.username, Array.from({ length: 14 }, (_, i) => {
    const day = new Date(now - (13 - i) * DAY).toISOString().slice(0, 10);
    const v = R() * u.quota_gb * GB * 0.03;
    return { day, down_bytes: Math.floor(v), up_bytes: Math.floor(v * 0.1), conns: Math.floor(R() * 90) };
  })]),
);

const audit = [
  { action: "login", actor: "admin" },
  { action: "user.create", actor: "admin", target: users[3].username },
  { action: "settings.update", actor: "admin", detail: { keys: ["clean_ips"] } },
  { action: "user.bulk.reset_traffic", actor: "admin", detail: { n: 12 } },
  { action: "user.delete", actor: "admin", target: "test-99" },
  { action: "backup.export", actor: "admin" },
  { action: "login_failed", actor: "unknown" },
  { action: "user.rotate_sub", actor: "admin", target: users[9].username },
].map((e, i) => ({ id: 100 - i, at: now - i * 3600_000 * (1 + R() * 5), ip_hash: hex(16), detail: e.detail ? JSON.stringify(e.detail) : null, ...e }));

let sessions = [
  { id: hex(16), subject: "admin", role: "owner", created_at: now - 3600_000 * 2, expires_at: now + 3600_000 * 10, ip_hash: hex(16), ua_hash: hex(16) },
  { id: hex(16), subject: "admin", role: "owner", created_at: now - DAY, expires_at: now + 3600_000 * 6, ip_hash: hex(16), ua_hash: hex(16) },
];

let installed = true;
const PASSWORD = "kaveh1234567"; // mock only — the real Worker uses PBKDF2

/* ══════════════ config generation (mirrors src/config/generator.js) ══════════════ */
function buildConfigs(user) {
  const host = settings.public_host || "kaveh.example.workers.dev";
  const port = Number(settings.port || 443);
  const ips = JSON.parse(user.ips || "[]");
  const pool = ips.length ? ips : JSON.parse(settings.clean_ips || "[]");
  const frag = user.fragment || settings.fragment_preset || "";
  const fp = user.fingerprint || settings.fingerprint || "";
  const items = (pool.length ? pool : [host]).slice(0, 8).map((ip, i) => ({
    uuid: user.uuid, host, address: ip, port, path: `/${user.uuid}`, fingerprint: fp,
    remark: pool.length > 1 ? `${settings.remark_prefix || host}#${i + 1}` : settings.remark_prefix || host,
  }));
  const uris = items.map((it) => {
    const q = new URLSearchParams({
      encryption: "none", security: "tls", type: "ws", host: it.host, sni: it.host,
      alpn: "http/1.1", path: it.path,
    });
    if (fp) q.set("fp", fp);
    if (frag && frag !== "none") { q.set("fragment", "100-200"); q.set("fragmentPackets", "tlshello"); }
    if (settings.mux_enabled === "1") { q.set("mux", "8"); q.set("xmux", "maxStreams=8"); }
    return `vless://${it.uuid}@${it.address}:${it.port}?${q.toString()}#${encodeURIComponent(it.remark)}`;
  });
  const singbox = {
    log: { level: "warn", timestamp: true },
    dns: { servers: [{ tag: "remote", address: "https://8.8.8.8/dns-query", detour: "select" }, { tag: "direct", address: "https://cloudflare-dns.com/dns-query", detour: "direct" }], final: "remote" },
    inbounds: [{ type: "tun", tag: "tun-in", inet4_address: "172.19.0.1/30", auto_route: true, strict_route: true, stack: "system" }],
    outbounds: [
      { type: "selector", tag: "select", outbounds: ["auto", ...items.map((_, i) => `node-${i}`)] },
      { type: "urltest", tag: "auto", outbounds: items.map((_, i) => `node-${i}`), url: "https://cp.cloudflare.com", interval: "3m" },
      { type: "direct", tag: "direct" },
      ...items.map((it, i) => ({
        type: "vless", tag: `node-${i}`, server: it.address, server_port: it.port, uuid: it.uuid,
        tls: { enabled: true, server_name: it.host, utls: it.fingerprint ? { enabled: true, fingerprint: it.fingerprint } : undefined },
        transport: { type: "ws", path: it.path, headers: { Host: it.host }, max_early_data: 2048, early_data_header_name: "Sec-WebSocket-Protocol" },
      })),
    ],
    route: { rules: [{ protocol: "dns", outbound: "dns-out" }, { ip_is_private: true, outbound: "direct" }, { domain_suffix: [".ir"], outbound: "direct" }], final: "select", auto_detect_interface: true },
  };
  const clash = [
    "mixed-port: 7890", "allow-lan: false", "mode: rule", "log-level: warning", "proxies:",
    ...items.flatMap((it, i) => [
      `  - name: "${it.remark || `node-${i}`}"`, `    type: vless`, `    server: "${it.address}"`, `    port: ${it.port}`,
      `    uuid: "${it.uuid}"`, `    tls: true`, `    servername: "${it.host}"`, `    client-fingerprint: "${it.fingerprint || "chrome"}"`,
      `    network: ws`, `    ws-opts:`, `      path: "${it.path}"`, `      max-early-data: 2048`,
      `      early-data-header-name: Sec-WebSocket-Protocol`, `      headers:`, `        Host: "${it.host}"`,
    ]),
    "proxy-groups:", `  - name: "SELECT"`, `    type: select`, `    proxies:`,
    ...items.map((it, i) => `      - "${it.remark || `node-${i}`}"`),
    "rules:", "  - DOMAIN-SUFFIX,ir,DIRECT", "  - GEOIP,IR,DIRECT", "  - MATCH,SELECT",
  ].join("\n");
  return { host, port, items, uris, vless: uris, singbox, clash, base64: Buffer.from(uris.join("\n"), "utf8").toString("base64"), qr: uris[0] || "" };
}

function hydrate(u) {
  const quotaBytes = Math.round(u.quota_gb * GB);
  const expired = u.expires_at != null && u.expires_at <= Date.now();
  return {
    ...u,
    ips: JSON.parse(u.ips || "[]"), proxies: JSON.parse(u.proxies || "[]"), block_list: JSON.parse(u.block_list || "[]"),
    is_active: !!u.is_active, first_connect: !!u.first_connect,
    quota_bytes: quotaBytes,
    used_pct: quotaBytes ? Math.min(100, Math.round((u.used_bytes / quotaBytes) * 1000) / 10) : 0,
    status: !u.is_active ? "disabled" : expired ? "expired" : u.used_bytes >= quotaBytes ? "exhausted" : "active",
    ms_left: u.expires_at ? Math.max(0, u.expires_at - Date.now()) : null,
  };
}

const log = (actor, action, target = null, detail = null) =>
  audit.unshift({ id: audit.length + 101, at: Date.now(), actor, action, target, ip_hash: hex(16), detail: detail ? JSON.stringify(detail) : null });

/* ══════════════ HTTP ══════════════ */
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  try {
    if (p.startsWith("/api/")) return api(req, res, url);
    if (p.startsWith("/s/")) {
      const u = users.find((x) => x.sub_token === p.slice(3));
      if (!u) return send(res, 404, "text/plain", "not found");
      const cfg = buildConfigs(u);
      const type = url.searchParams.get("type") || "base64";
      const body = type === "singbox" ? JSON.stringify(cfg.singbox, null, 2) : type === "clash" ? cfg.clash : type === "raw" ? cfg.uris.join("\n") : cfg.base64;
      // Mirrors src/config/generator.js exactly: `expire` is omitted when the
      // user has no deadline yet (first-connect clock not started).
      const info = [`upload=0`, `download=${u.used_bytes}`, `total=${Math.round(u.quota_gb * GB)}`];
      if (u.expires_at) info.push(`expire=${Math.floor(u.expires_at / 1000)}`);
      res.setHeader("subscription-userinfo", info.join(";"));
      res.setHeader("profile-update-interval", "10");
      return send(res, 200, "text/plain; charset=utf-8", body);
    }
    if (p.startsWith("/status/")) {
      const id = p.slice(8);
      const u = users.find((x) => x.sub_token === id || x.uuid === id);
      if (!u) return send(res, 404, "text/html", "<h1>404</h1>");
      const h = hydrate(u);
      const cfg = buildConfigs(u);
      return send(res, 200, "text/html; charset=utf-8", `<!doctype html><html lang="fa" dir="rtl" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h.username}</title><link rel="stylesheet" href="/assets/app.css"></head><body class="status-page"><main class="status-card"><h1>${h.username}</h1><p class="muted">${h.status}</p><div class="meter"><div class="meter-fill" style="width:${h.used_pct}%"></div></div><dl><div><dt>مصرف</dt><dd>${(h.used_bytes / GB).toFixed(2)} / ${h.quota_gb} GB</dd></div><div><dt>انقضا</dt><dd>${new Date(h.expires_at).toLocaleDateString("fa-IR")}</dd></div><div><dt>دستگاه</dt><dd>${h.device_limit}</dd></div></dl><pre class="config">${cfg.uris[0] || ""}</pre></main></body></html>`);
    }
    // static
    let file = p === "/" || p === "/panel" || p === "/login" ? "/index.html" : p;
    if (file === "/manifest.json") file = "/manifest.webmanifest";
    const full = normalize(join(UI, file));
    if (!full.startsWith(UI)) return send(res, 403, "text/plain", "forbidden");
    const st = await stat(full).catch(() => null);
    if (!st || st.isDirectory()) {
      const idx = join(full, "index.html");
      const st2 = await stat(idx).catch(() => null);
      if (st2) return send(res, 200, "text/html; charset=utf-8", await readFile(idx, "utf8"));
      return send(res, 200, "text/html; charset=utf-8", await readFile(join(UI, "index.html"), "utf8"));
    }
    return send(res, 200, MIME[extname(full)] || "application/octet-stream", await readFile(full));
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, code: "internal_error", error: String(e.message || e) });
  }
});

function send(res, status, type, body) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}
function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
const okJson = (res, body) => json(res, 200, { ok: true, ...body });
async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  const q = url.searchParams;
  const who = "admin";

  if (p === "/api/whoami") return okJson(res, { username: installed ? who : null, role: "owner", installed, panelName: settings.panel_name, version: "0.1.0" });

  if (p === "/api/login" && m === "POST") {
    const b = await body(req);
    if (b.password !== PASSWORD) return json(res, 401, { ok: false, code: "unauthorized", error: "رمز عبور اشتباه است" });
    log(who, "login");
    return okJson(res, { username: who, role: "owner" });
  }
  if (p === "/api/setup" && m === "POST") { installed = true; return okJson(res, { username: who }); }
  if (p === "/api/logout" && m === "POST") return okJson(res, {});
  if (p === "/api/recover" && m === "POST") return okJson(res, {});
  if (p === "/api/password" && m === "POST") { log(who, "change_password"); return okJson(res, {}); }

  if (p === "/api/overview") {
    const total = users.length;
    const active = users.filter((u) => u.is_active).length;
    const expired = users.filter((u) => u.expires_at && u.expires_at <= Date.now()).length;
    const used = users.reduce((a, u) => a + u.used_bytes, 0);
    const requests = users.reduce((a, u) => a + u.requests_used, 0);
    return okJson(res, {
      users: { total, active, expired, used_bytes: used, requests },
      cloudflare: { available: true, total: 1_840_000, daily: 62_400, limit: 100_000, pct: 62.4 },
      series,
      top: [...users].sort((a, b) => b.used_bytes - a.used_bytes).slice(0, 8).map((u) => ({ username: u.username, used_bytes: u.used_bytes, quota_gb: u.quota_gb, requests_used: u.requests_used })),
      settings: { panelName: settings.panel_name, publicHost: settings.public_host },
    });
  }

  if (p === "/api/users" && m === "GET") {
    const search = (q.get("q") || "").toLowerCase();
    const status = q.get("status") || "all";
    const sort = q.get("sort") || "created_at";
    const dir = q.get("dir") || "desc";
    const page = Math.max(1, Number(q.get("page") || 1));
    const size = Math.min(200, Number(q.get("size") || 25));
    let list = users.map(hydrate);
    if (search) list = list.filter((u) => [u.username, u.note, u.uuid].some((f) => String(f).toLowerCase().includes(search)));
    if (status !== "all") list = list.filter((u) => u.status === status);
    list.sort((a, b) => {
      const av = a[sort] ?? 0, bv = b[sort] ?? 0;
      const c = typeof av === "string" ? av.localeCompare(bv) : av - bv;
      return dir === "asc" ? c : -c;
    });
    return okJson(res, { users: list.slice((page - 1) * size, page * size), total: list.length, page, size, pages: Math.ceil(list.length / size) });
  }

  if (p === "/api/users" && m === "POST") {
    const b = await body(req);
    if (!b.username) return json(res, 400, { ok: false, code: "bad_request", error: "نام کاربری لازم است" });
    if (users.some((u) => u.username === b.username)) return json(res, 409, { ok: false, code: "conflict", error: `کاربر «${b.username}» از قبل وجود دارد` });
    const u = {
      id: users.length + 1, username: b.username, uuid: crypto.randomUUID(), sub_token: hex(32),
      quota_gb: Number(b.quota_gb || 50), used_bytes: 0, expiry_days: Number(b.expiry_days || 30),
      first_connect: b.first_connect === false ? 0 : 1, activated_at: null,
      expires_at: b.first_connect === false ? Date.now() + Number(b.expiry_days || 30) * DAY : null,
      device_limit: Number(b.device_limit || 3), request_limit: Number(b.request_limit || 0), requests_used: 0,
      ips: JSON.stringify(b.ips || []), proxies: JSON.stringify(b.proxies || []), connection: "ws", tls: "on",
      fragment: b.fragment || "", fingerprint: b.fingerprint || "", block_list: JSON.stringify(b.block_list || []),
      is_active: b.is_active === false ? 0 : 1, created_by: who, note: b.note || "", created_at: Date.now(), updated_at: Date.now(),
    };
    users.unshift(u);
    log(who, "user.create", u.username);
    return okJson(res, { user: hydrate(u), configs: buildConfigs(u) });
  }

  if (p === "/api/users/bulk" && m === "POST") {
    const b = await body(req);
    const set = new Set(b.usernames || []);
    let affected = 0;
    if (b.op === "delete") {
      for (let i = users.length - 1; i >= 0; i--) if (set.has(users[i].username)) { users.splice(i, 1); affected++; }
    } else {
      for (const u of users) {
        if (!set.has(u.username)) continue;
        affected++;
        if (b.op === "enable") u.is_active = 1;
        if (b.op === "disable") u.is_active = 0;
        if (b.op === "reset_traffic") u.used_bytes = 0;
        if (b.op === "reset_requests") u.requests_used = 0;
        if (b.op === "extend") u.expires_at = (u.expires_at || Date.now()) + Number(b.value || 30) * DAY;
        u.updated_at = Date.now();
      }
    }
    log(who, `user.bulk.${b.op}`, null, { n: affected });
    return okJson(res, { affected, op: b.op });
  }

  const um = /^\/api\/users\/([^/]+)(?:\/([\w-]+))?$/.exec(p);
  if (um) {
    const name = decodeURIComponent(um[1]);
    const sub = um[2];
    const idx = users.findIndex((u) => u.username === name);
    if (idx < 0) return json(res, 404, { ok: false, code: "not_found", error: "user not found" });
    const u = users[idx];
    if (!sub && m === "GET") return okJson(res, { user: hydrate(u), configs: buildConfigs(u) });
    if (!sub && m === "PATCH") {
      const b = await body(req);
      Object.assign(u, {
        ...b,
        ips: b.ips ? JSON.stringify(b.ips) : u.ips,
        proxies: b.proxies ? JSON.stringify(b.proxies) : u.proxies,
        block_list: b.block_list ? JSON.stringify(b.block_list) : u.block_list,
        is_active: b.is_active === undefined ? u.is_active : b.is_active ? 1 : 0,
        first_connect: b.first_connect === undefined ? u.first_connect : b.first_connect ? 1 : 0,
        updated_at: Date.now(),
      });
      if (b.expiry_days) u.expires_at = Date.now() + Number(b.expiry_days) * DAY;
      log(who, "user.update", name, { keys: Object.keys(b) });
      return okJson(res, { user: hydrate(u), configs: buildConfigs(u) });
    }
    if (!sub && m === "DELETE") { users.splice(idx, 1); log(who, "user.delete", name); return okJson(res, {}); }
    if (sub === "reset") { u.used_bytes = 0; u.requests_used = 0; log(who, "user.reset", name); return okJson(res, { user: hydrate(u) }); }
    if (sub === "rotate-token") { u.sub_token = hex(32); log(who, "user.rotate_sub", name); return okJson(res, { sub_token: u.sub_token }); }
    if (sub === "rotate-uuid") { u.uuid = crypto.randomUUID(); log(who, "user.rotate_uuid", name); return okJson(res, { uuid: u.uuid }); }
  }

  if (p === "/api/stats/usage") {
    const name = q.get("username");
    return okJson(res, { username: name, series: usageByUsername[name] || [] });
  }

  if (p === "/api/settings" && m === "GET") {
    const s = { ...settings };
    delete s.admin_hash;
    return okJson(res, { settings: s });
  }
  if (p === "/api/settings" && m === "PUT") {
    const b = await body(req);
    for (const [k, v] of Object.entries(b)) settings[k] = typeof v === "string" ? v : JSON.stringify(v);
    log(who, "settings.update", null, { keys: Object.keys(b) });
    return okJson(res, { settings });
  }

  if (p === "/api/backup" && m === "GET") {
    return send(res, 200, "application/json", JSON.stringify({ format: "kaveh-backup", version: 1, exported_at: new Date().toISOString(), users, settings, plans: [], nodes: [] }, null, 2));
  }
  if (p === "/api/backup" && m === "POST") {
    const b = await body(req);
    return okJson(res, { imported: b.users?.length || 0, mode: b.mode || "replace" });
  }

  if (p === "/api/fragments") {
    return okJson(res, {
      presets: [
        { id: "none", label: "بدون فرگمنت" }, { id: "mci", label: "همراه اول (MCI)" }, { id: "irancell", label: "ایرانسل" },
        { id: "rightel", label: "رایتل" }, { id: "tci", label: "مخابرات (TCI)" }, { id: "aggressive", label: "حالت تهاجمی" },
      ],
      fingerprints: ["chrome", "safari", "ios", "android", "edge", "firefox", "randomized"],
      tlsPorts: [443, 2053, 2083, 2087, 2096, 8443], httpPorts: [80, 8080, 8880, 2052, 2082, 2086, 2095],
    });
  }

  if (p === "/api/diag/cf-usage") return okJson(res, { available: true, daily: 62400, total: 1840000, limit: 100000, pct: 62.4 });
  if (p === "/api/diag/probe-node" && m === "POST") {
    const b = await body(req);
    await new Promise((r) => setTimeout(r, 700));
    const good = !/^(?!.*@).*$/.test(b.proxy || "") || (b.proxy || "").split(".").length === 4;
    // (this was missing its `res` argument — the mock 500'd on every probe)
    return okJson(res, good
      ? { spec: b.proxy, ok: true, latencyMs: 120 + Math.floor(Math.random() * 180) }
      : { spec: b.proxy, ok: false, latencyMs: 3000, error: "connection refused" });
  }
  if (p === "/api/diag/rank-ips" && m === "POST") {
    const b = await body(req);
    await new Promise((r) => setTimeout(r, 900));
    const ips = (b.ips || []).filter(() => Math.random() > 0.25);
    return okJson(res, { total: (b.ips || []).length, healthy: ips.length, ips });
  }
  if (p === "/api/diag/ping") {
    await new Promise((r) => setTimeout(r, 800));
    const s = [1, 2, 3].map(() => ({ ms: 18 + Math.floor(Math.random() * 40), status: 200 }));
    return okJson(res, { target: q.get("target"), samples: s, colo: "FRA", country: "DE", avg: Math.round(s.reduce((a, b) => a + b.ms, 0) / 3), loss: "0/3" });
  }
  if (p === "/api/diag/logs") return okJson(res, { entries: audit.slice(0, Number(q.get("limit") || 50)) });

  // Same two entrypoints the Worker exposes: the cron body, and lifting a
  // brute-force ban. The UI has buttons for both, so the mock must answer them
  // or the panel "works in dev, 404s in prod" — the exact failure the contract
  // test exists to catch.
  if (p === "/api/diag/maintenance" && m === "POST") {
    await new Promise((r) => setTimeout(r, 260));
    const expired = users.filter((u) => u.expires_at && u.expires_at < Date.now()).length;
    audit.unshift({ at: Date.now(), actor: "admin", action: "maintenance.manual", target: "", ip_hash: "a1b2c3d4" });
    return okJson(res, { expired_handled: expired, policy: settings.on_expiry || "disable", ips_rotated: 0, sessions_purged: 1, ms: 240 + Math.floor(Math.random() * 40) });
  }
  if (p === "/api/diag/unban" && m === "POST") {
    const b = await body(req);
    const ip = b.ip || q.get("ip") || "203.0.113.7";
    audit.unshift({ at: Date.now(), actor: "admin", action: "guard.unban", target: ip, ip_hash: "a1b2c3d4" });
    return okJson(res, { ip, ok: true, unbanned: `login:${ip}` });
  }

  if (p === "/api/sessions" && m === "GET") return okJson(res, { sessions });
  if (p === "/api/sessions/revoke" && m === "POST") {
    const b = await body(req);
    sessions = b.all ? [] : sessions.filter((s) => s.id !== b.id);
    log(who, "revoke_session", null, { all: !!b.all });
    return okJson(res, {});
  }

  // ── agent (control-plane channel) — same contract as src/api/agent.js ──
  const am = /^\/api\/agent(?:\/users(?:\/([^/]+))?(?:\/(reset))?)?$|^\/api\/agent\/admin\/reset$/.exec(p);
  if (am && p.startsWith("/api/agent")) {
    const DEV_KEY = "dev-agent-key";
    if ((req.headers["x-kaveh-agent"] || "") !== DEV_KEY) {
      return json(res, 403, { ok: false, code: "forbidden", error: "کلید عامل نامعتبر است" });
    }
    if (p === "/api/agent/health") return okJson(res, { service: "kaveh", version: "0.1.0", installed: true, users: users.length });
    if (p === "/api/agent/users" && m === "GET") return okJson(res, { users, total: users.length, page: 1, size: 50, pages: 1 });
    if (p === "/api/agent/users" && m === "POST") {
      const b = await body(req);
      const u = { ...users[0], username: b.username || "agent-made", uuid: crypto.randomUUID(), sub_token: crypto.randomUUID().replaceAll("-", ""), used_bytes: 0, quota_gb: b.quota_gb || 50, is_active: true, status: "active" };
      users.unshift(u);
      return okJson(res, { user: u, configs: { uris: [`vless://${u.uuid}@example.net:443?security=tls&type=ws#mock`], singbox: { outbounds: [] }, clash: "", base64: "" } });
    }
    if (p === "/api/agent/admin/reset" && m === "POST") return okJson(res, { installed: false, note: "panel is in first-run setup again" });
    const um2 = /^\/api\/agent\/users\/([^/]+)(?:\/(reset))?$/.exec(p);
    if (um2) {
      const u = users.find((x) => x.username === um2[1]);
      if (!u) return json(res, 404, { ok: false, code: "not_found", error: "user" });
      if (um2[2] === "reset" && m === "POST") { u.used_bytes = 0; return okJson(res, { reset: true }); }
      if (m === "DELETE") { users.splice(users.indexOf(u), 1); return okJson(res, { deleted: true }); }
      if (m === "GET") return okJson(res, { user: u, configs: { uris: [`vless://${u.uuid}@example.net:443?security=tls&type=ws#mock`], singbox: { outbounds: [] }, clash: "", base64: "" } });
    }
  }

  return json(res, 404, { ok: false, code: "not_found", error: `mock API: ${m} ${p} پیاده‌سازی نشده` });
}

server.listen(PORT, HOST, () => {
  console.log(`\n  ⚒️  Kaveh dev server`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → password: ${PASSWORD}\n`);
});
