/**
 * Standalone Cloudflare-token intake for the DNS center only.
 *
 * The DNS center is its own environment: it never sends people to the
 * dedicated-environment panel to connect Cloudflare. This module serves a
 * single-purpose, one-time-link form («مرکز DNS — اتصال Cloudflare») that takes
 * a scoped API token, verifies it against Cloudflare and stores the connection
 * for the tenant. The token is submitted over HTTPS to this form only — never
 * in Telegram chat, never through the dedicated panel.
 */
import { createTemporaryApiTokenConnection } from "./api-token";
import { botPrincipal } from "./bot-actions";
import { audit, rateLimit } from "./db";
import { html, HttpError } from "./http";
import { escapeHtml, nowIso, randomToken, sha256 } from "./security";
import type { Env } from "./types";

interface LoginLinkRow {
  tenant_id: string;
  expires_at: string;
  consumed_at: string | null;
}

async function peekLoginLink(env: Env, token: string): Promise<LoginLinkRow | null> {
  if (token.length < 32 || token.length > 128) return null;
  const tokenHash = await sha256(token);
  const link = await env.DB.prepare(
    "SELECT tenant_id, expires_at, consumed_at FROM login_links WHERE token_hash = ?",
  )
    .bind(tokenHash)
    .first<LoginLinkRow>();
  if (!link || link.consumed_at || Date.parse(link.expires_at) <= Date.now()) return null;
  return link;
}

async function consumeLoginLink(env: Env, token: string): Promise<boolean> {
  const tokenHash = await sha256(token);
  const consumed = await env.DB.prepare(
    "UPDATE login_links SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL",
  )
    .bind(nowIso(), tokenHash)
    .run();
  return (consumed.meta.changes ?? 0) === 1;
}

/**
 * Cloudflare dashboard deep link that opens the token-creation page with every
 * permission pre-configured (official template-URL format), so the user only
 * picks one zone, presses Create and copies the token.
 */
export function cloudflareTokenTemplateUrl(): string {
  // NOTE: the zone permission key for DNS records is "dns" in Cloudflare's
  // template-URL format (not "dns_records"); an unknown key is dropped
  // silently and the created token then lacks DNS Edit everywhere.
  const permissions = [
    { key: "zone", type: "read" },
    { key: "dns", type: "edit" },
    { key: "workers_scripts", type: "edit" },
    { key: "workers_kv_storage", type: "edit" },
    { key: "d1", type: "edit" },
  ];
  const encoded = encodeURIComponent(JSON.stringify(permissions));
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encoded}&accountId=*&zoneId=all&name=V13-OMNI-ROUTER`;
}

/**
 * Panel-catalog token template: Workers/KV/D1 + zone read, deliberately NO DNS
 * Edit — panels deploy on workers.dev and never touch DNS records, and asking
 * for DNS Edit dragged users into the single-zone strictness of the DNS center.
 */
export function cloudflarePanelTemplateUrl(): string {
  const permissions = [
    { key: "zone", type: "read" },
    { key: "workers_scripts", type: "edit" },
    { key: "workers_kv_storage", type: "edit" },
    { key: "d1", type: "edit" },
  ];
  const encoded = encodeURIComponent(JSON.stringify(permissions));
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encoded}&accountId=*&zoneId=all&name=V13-PANEL-DEPLOY`;
}

/** One-time link for the standalone connect form (deliberately NOT the panel /login). */
export async function issueConnectLink(env: Env, tenantId: string, next: "dns" | "panel"): Promise<{ url: string; ttlMinutes: number }> {
  const raw = randomToken(32);
  const tokenHash = await sha256(raw);
  const ttlSeconds = 900;
  await env.DB.prepare(
    "INSERT INTO login_links (token_hash, tenant_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(tokenHash, tenantId, new Date(Date.now() + ttlSeconds * 1000).toISOString(), nowIso())
    .run();
  const url = `${new URL(env.PUBLIC_BASE_URL).origin}/connect?t=${encodeURIComponent(raw)}&next=${next}`;
  return { url, ttlMinutes: Math.floor(ttlSeconds / 60) };
}

function page(document: string, nonce: string): Response {
  return html(
    `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>مرکز DNS — اتصال Cloudflare</title>
<style nonce="${nonce}">
body{font-family:system-ui,sans-serif;background:#0b1020;color:#e8ecf8;margin:0;padding:24px;display:flex;justify-content:center}
main{max-width:520px;width:100%;background:#141a33;border:1px solid #2a3358;border-radius:16px;padding:24px}
h1{font-size:20px;margin:0 0 8px}
p{font-size:14px;line-height:1.9;color:#b9c2e0}
code{background:#0b1020;border:1px solid #2a3358;border-radius:6px;padding:2px 6px;font-size:12px}
input[type=password]{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #2a3358;background:#0b1020;color:#e8ecf8;font-size:14px}
button{margin-top:14px;width:100%;padding:12px;border:0;border-radius:10px;background:#3b6df0;color:#fff;font-size:15px;font-weight:700}
.err{background:#3a1420;border:1px solid #7a2438;color:#ffb4c0;border-radius:10px;padding:10px;font-size:13px}
a.cf{display:block;text-align:center;text-decoration:none;background:#f6821f;color:#101010;font-weight:700;padding:12px;border-radius:10px;margin:14px 0 10px}
ol{font-size:13px;line-height:2;color:#b9c2e0;padding-right:18px;margin:0 0 6px}
.ok{background:#12351f;border:1px solid #2c7a44;color:#b8f5c8;border-radius:10px;padding:10px;font-size:14px;line-height:1.9}
</style></head><body><main>${document}</main></body></html>`,
    nonce,
  );
}

function formBody(error: string | null, token: string, next: "dns" | "panel"): string {
  const title = next === "dns" ? "🌐 مرکز DNS — اتصال Cloudflare" : "🚀 پنل‌ها — اتصال Cloudflare";
  const scopeNote = next === "dns"
    ? "این فرم فقط و فقط مال <b>مرکز DNS</b> است؛ هیچ ربطی به محیط اختصاصی V13 ندارد.<br>"
    : "این فرم فقط برای <b>استقرار پنل‌ها</b> است؛ هیچ ربطی به محیط اختصاصی V13 ندارد.<br>";
  return [
    `<h1>${title}</h1>`,
    `<p>${scopeNote}توکن API اسکوپ‌شده را این‌جا بگذارید تا همه‌چیز خودکار انجام شود.</p>`,
    `<p>⚠️ توکن را هرگز در چت تلگرام نفرستید؛ فقط همین فرم.</p>`,
    `<a class="cf" href="${escapeHtml(cloudflareTokenTemplateUrl())}">☁️ ساخت Token آماده در Cloudflare (همهٔ تنظیمات از قبل چیده شده)</a>`,
    `<ol><li>روی دکمهٔ بالا بزنید: صفحهٔ ساخت توکن Cloudflare با <b>همهٔ دسترسی‌های لازم از قبل انتخاب‌شده</b> باز می‌شود.</li><li>فقط در بخش Zone Resources <b>یک zone</b> را انتخاب کنید.</li><li>«Continue» و «Create Token» و سپس «Copy».</li><li>همین‌جا پیست کنید و دکمهٔ ثبت را بزنید — بقیهٔ کارها خودکار است.</li></ol>`,
    error ? `<p class="err">${escapeHtml(error)}</p>` : "",
    `<form method="post" action="/connect">
<input type="hidden" name="t" value="${escapeHtml(token)}">
<input type="hidden" name="next" value="${next}">
<input type="password" name="apiToken" autocomplete="off" placeholder="Cloudflare API Token" required minlength="20" maxlength="256">
<button type="submit">ثبت اتصال و ادامهٔ خودکار</button>
</form>`,
  ].join("\n");
}

function nextOf(request: Request): "dns" | "panel" {
  return new URL(request.url).searchParams.get("next") === "panel" ? "panel" : "dns";
}

export async function dnsConnectGet(request: Request, env: Env): Promise<Response> {
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const nonce = randomToken(16);
  const link = await peekLoginLink(env, token);
  if (!link) {
    return page("<h1>⌛ لینک معتبر نیست</h1><p class=\"err\">این لینک یک‌بارمصرف منقضی یا مصرف شده است. در ربات دوباره «🔑 اتصال Cloudflare» را بزنید تا لینک تازه ساخته شود.</p>", nonce);
  }
  return page(formBody(null, token, nextOf(request)), nonce);
}

export async function dnsConnectPost(request: Request, env: Env): Promise<Response> {
  const allowed = await rateLimit(env, `dns-connect:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`, 10, 600);
  if (!allowed) throw new HttpError(429, "rate_limited", "Too many attempts; try again later");
  const form = new URLSearchParams(await request.text());
  const token = form.get("t") ?? "";
  const apiToken = form.get("apiToken") ?? "";
  const next: "dns" | "panel" = form.get("next") === "panel" ? "panel" : "dns";
  const nonce = randomToken(16);
  const link = await peekLoginLink(env, token);
  if (!link) {
    return page("<h1>⌛ لینک معتبر نیست</h1><p class=\"err\">لینک منقضی یا مصرف شده است؛ از ربات لینک تازه بگیرید.</p>", nonce);
  }
  const principal = botPrincipal(link.tenant_id, "dns-connect-form", "مرکز DNS");
  const internal = new Request(new URL("/api/v1/cloudflare/api-token", new URL(request.url).origin), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiToken }),
  });
  try {
    const response = await createTemporaryApiTokenConnection(internal, env, principal);
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      return page(formBody(payload?.error?.message ?? "Cloudflare توکن را نپذیرفت؛ اسکوپ zone را بررسی کنید.", token, next), nonce);
    }
  } catch (error) {
    const message = error instanceof HttpError ? error.message : "Cloudflare توکن را نپذیرفت؛ اسکوپ zone را بررسی کنید.";
    return page(formBody(message, token, next), nonce);
  }
  await consumeLoginLink(env, token);
  await audit(env, {
    tenantId: link.tenant_id,
    actorType: "user",
    actorId: "dns-connect-form",
    action: "dnscenter.connection.create",
    outcome: "success",
    request,
  });
  const okBody = next === "dns"
    ? "<h1>✅ اتصال مرکز DNS ساخته شد</h1><p class=\"ok\">به ربات برگردید؛ سازنده‌های Master DNS، White DNS و Slipstream حالا zone شما را می‌بینند و خودکار منتشر می‌کنند.</p>"
    : "<h1>✅ اتصال ساخته شد</h1><p class=\"ok\">به ربات برگردید و همان پنل را دوباره بزنید؛ استقرار خودکار ادامه پیدا می‌کند.</p>";
  return page(okBody, nonce);
}
