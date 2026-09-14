/** Tiny response helpers. No framework — Workers is fast enough on its own. */

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function ok(body = {}) {
  return json({ ok: true, ...body });
}

export function text(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });
}

export function noContent() {
  return new Response(null, { status: 204 });
}

export async function readJson(request) {
  const raw = await request.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new (await import("./errors.js")).badRequest("بدنه‌ی درخواست JSON معتبر نیست");
  }
}

/**
 * Security headers, applied once by the middleware pipeline.
 * Zeus sends only `content-type` — no CSP, no frame protection, no referrer
 * policy — on a panel that stores a Cloudflare API token.
 */
export function securityHeaders(isHtml = true) {
  const h = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "geolocation=(), microphone=(), camera=()",
    "cross-origin-opener-policy": "same-origin",
  };
  if (isHtml) {
    // No CDNs are used anywhere in Kaveh, so CSP can be strict: nothing loads
    // except same-origin assets. Zeus pulls Tailwind, Three.js, Sortable,
    // qr-code-styling, Vazirmatn and flag-icons from 3 different CDNs, any of
    // which can be blocked, slow, or swapped — inside your admin panel.
    h["content-security-policy"] = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; ");
  }
  return h;
}

export function clientIp(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "0.0.0.0"
  );
}
