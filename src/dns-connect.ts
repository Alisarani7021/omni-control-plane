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

/** One-time link for the DNS-center form (deliberately NOT the panel /login). */
export async function issueDnsConnectLink(env: Env, tenantId: string): Promise<{ url: string; ttlMinutes: number }> {
  const raw = randomToken(32);
  const tokenHash = await sha256(raw);
  const ttlSeconds = 900;
  await env.DB.prepare(
    "INSERT INTO login_links (token_hash, tenant_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(tokenHash, tenantId, new Date(Date.now() + ttlSeconds * 1000).toISOString(), nowIso())
    .run();
  const url = `${new URL(env.PUBLIC_BASE_URL).origin}/dns/connect?t=${encodeURIComponent(raw)}`;
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
.ok{background:#12351f;border:1px solid #2c7a44;color:#b8f5c8;border-radius:10px;padding:10px;font-size:14px;line-height:1.9}
</style></head><body><main>${document}</main></body></html>`,
    nonce,
  );
}

function formBody(error: string | null, token: string): string {
  return [
    "<h1>🌐 مرکز DNS — اتصال Cloudflare</h1>",
    "<p>این فرم فقط و فقط مال <b>مرکز DNS</b> است؛ هیچ ربطی به محیط اختصاصی V13 ندارد.<br>توکن API اسکوپ‌شده (دست‌کم <code>Zone:Zone:Read</code> و <code>Zone:DNS:Edit</code> روی یک zone) را این‌جا بگذارید تا سازنده‌های Master/White DNS مستقیم در zone خودتان منتشر کنند.</p>",
    "<p>⚠️ توکن را هرگز در چت تلگرام نفرستید؛ فقط همین فرم.</p>",
    error ? `<p class="err">${escapeHtml(error)}</p>` : "",
    `<form method="post" action="/dns/connect">
<input type="hidden" name="t" value="${escapeHtml(token)}">
<input type="password" name="apiToken" autocomplete="off" placeholder="Cloudflare API Token" required minlength="20" maxlength="256">
<button type="submit">ثبت اتصال مرکز DNS</button>
</form>`,
  ].join("\n");
}

export async function dnsConnectGet(request: Request, env: Env): Promise<Response> {
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const nonce = randomToken(16);
  const link = await peekLoginLink(env, token);
  if (!link) {
    return page("<h1>⌛ لینک معتبر نیست</h1><p class=\"err\">این لینک یک‌بارمصرف منقضی یا مصرف شده است. در ربات دوباره «🔑 اتصال Cloudflare» را بزنید تا لینک تازه ساخته شود.</p>", nonce);
  }
  return page(formBody(null, token), nonce);
}

export async function dnsConnectPost(request: Request, env: Env): Promise<Response> {
  const allowed = await rateLimit(env, `dns-connect:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`, 10, 600);
  if (!allowed) throw new HttpError(429, "rate_limited", "Too many attempts; try again later");
  const form = new URLSearchParams(await request.text());
  const token = form.get("t") ?? "";
  const apiToken = form.get("apiToken") ?? "";
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
      return page(formBody(payload?.error?.message ?? "Cloudflare توکن را نپذیرفت؛ اسکوپ zone را بررسی کنید.", token), nonce);
    }
  } catch (error) {
    const message = error instanceof HttpError ? error.message : "Cloudflare توکن را نپذیرفت؛ اسکوپ zone را بررسی کنید.";
    return page(formBody(message, token), nonce);
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
  return page(
    "<h1>✅ اتصال مرکز DNS ساخته شد</h1><p class=\"ok\">اتصال Cloudflare فقط برای مرکز DNS ثبت شد.<br>به ربات برگردید؛ سازنده‌های Master DNS، White DNS و Slipstream حالا zone شما را می‌بینند و خودکار منتشر می‌کنند.</p>",
    nonce,
  );
}
