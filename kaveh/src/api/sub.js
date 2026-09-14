import { base64Subscription, subscriptionInfoHeader } from "../config/generator.js";
import * as Users from "../db/users.js";
import { buildConfigs } from "./users.js";
import { notFound, forbidden } from "../core/errors.js";

/**
 * Subscription endpoint: `/s/<token>`.
 *
 * Content negotiation happens on User-Agent *and* an explicit `?type=`, which
 * is what real clients need — v2rayNG wants base64, Happ/sing-box want JSON,
 * Clash wants YAML. Zeus forces the browser to guess from the UA only and
 * returns base64 for everything else, which is why people copy-paste from a
 * "convert" website.
 */
export async function subscription(request, E, token) {
  const user = await Users.getUserBySubToken(E, token);
  if (!user) throw notFound("subscription");
  if (!user.is_active) throw forbidden("اشتراک غیرفعال است");

  activateIfNeeded(E, user, request);

  const url = new URL(request.url);
  const ua = (request.headers.get("user-agent") || "").toLowerCase();
  const type = url.searchParams.get("type") || guessType(ua);
  const cfg = await buildConfigs(E, user, request);

  const headers = {
    "content-disposition": `attachment; filename="${user.username}.txt"`,
    "profile-update-interval": String(Math.max(1, Math.floor((user.expiry_days || 30) / 3))),
    "subscription-userinfo": subscriptionInfoHeader({
      used: user.used_bytes,
      total: user.quota_bytes,
      expireAt: user.expires_at,
    }),
    "cache-control": "no-store",
  };

  if (type === "singbox" || type === "json") {
    return new Response(JSON.stringify(cfg.singbox, null, 2), { headers: { ...headers, "content-type": "application/json; charset=utf-8" } });
  }
  if (type === "clash" || type === "yaml") {
    return new Response(cfg.clash, { headers: { ...headers, "content-type": "text/yaml; charset=utf-8" } });
  }
  if (type === "raw") {
    return new Response(cfg.uris.join("\n"), { headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
  }
  return new Response(base64Subscription(cfg.uris), { headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
}

function guessType(ua) {
  if (ua.includes("sing-box") || ua.includes("happ") || ua.includes("streisand") || ua.includes("v2box")) return "singbox";
  if (ua.includes("clash") || ua.includes("stash") || ua.includes("mihomo")) return "clash";
  if (ua.includes("karing")) return "singbox";
  return "base64";
}

/**
 * "Start the clock on first connect". If enabled, the expiry deadline is set
 * the first time this user actually opens a tunnel or fetches their sub.
 * Fire-and-forget: a failed write must never break the subscription.
 */
export function activateIfNeeded(E, user, request) {
  if (!user.first_connect || user.activated_at) return;
  const now = Date.now();
  return (request?.ctx ?? E.ctx)?.waitUntil?.(
    E.db
      .prepare("UPDATE users SET activated_at = ?, expires_at = ? WHERE username = ? AND activated_at IS NULL")
      .bind(now, now + user.expiry_days * 86400000, user.username)
      .run()
      .catch(() => {}),
  );
}

/** Public self-service status page: usage, expiry, and a fresh QR. */
export async function statusPage(request, E, id) {
  const user = (await Users.getUserBySubToken(E, id)) || (await Users.getUserByUuid(E, id));
  if (!user) throw notFound("status page");
  const cfg = await buildConfigs(E, user, request);
  const S = await import("../db/index.js").then((m) => new m.Settings(E));
  if ((await S.get("status_page_enabled")) === "0") throw notFound("status page");
  return new Response(renderStatus(user, cfg), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function renderStatus(user, cfg) {
  const pct = user.used_pct;
  const left = user.ms_left == null ? "—" : humanDuration(user.ms_left);
  const gb = (n) => (n / 1024 ** 3).toFixed(2);
  return `<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${user.username} — وضعیت اشتراک</title>
<link rel="stylesheet" href="/assets/app.css">
</head><body class="status-page">
<main class="status-card">
  <h1>${escapeHtml(user.username)}</h1>
  <p class="muted">${user.status === "active" ? "🟢 فعال" : user.status === "expired" ? "🔴 منقضی" : user.status === "exhausted" ? "🟠 حجم تمام" : "⚪ غیرفعال"}</p>
  <div class="meter"><div class="meter-fill" style="width:${pct}%"></div></div>
  <dl>
    <div><dt>مصرف</dt><dd>${gb(user.used_bytes)} از ${gb(user.quota_bytes)} گیگابایت</dd></div>
    <div><dt>زمان باقی‌مانده</dt><dd>${left}</dd></div>
    <div><dt>دستگاه‌های مجاز</dt><dd>${user.device_limit}</dd></div>
  </dl>
  <pre class="config">${escapeHtml(cfg.uris[0] || "")}</pre>
</main>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function humanDuration(ms) {
  if (ms <= 0) return "تمام شده";
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  return d > 0 ? `${d} روز و ${h} ساعت` : `${h} ساعت`;
}
