import { normalizeBaseUrl, randomToken } from "./security";
import type { Env } from "./types";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const BASE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export function secureHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(BASE_HEADERS);
  if (extra) new Headers(extra).forEach((value, key) => headers.set(key, value));
  return headers;
}

export function json(data: unknown, status = 200, extra?: HeadersInit): Response {
  return Response.json(data, {
    status,
    headers: secureHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      ...Object.fromEntries(new Headers(extra ?? {}).entries()),
    }),
  });
}

export function html(document: string, nonce: string, status = 200, extra?: HeadersInit): Response {
  return new Response(document, {
    status,
    headers: secureHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
      ...Object.fromEntries(new Headers(extra ?? {}).entries()),
    }),
  });
}

export function redirect(location: string, status = 303, extra?: HeadersInit): Response {
  return new Response(null, { status, headers: secureHeaders({ Location: location, ...Object.fromEntries(new Headers(extra ?? {}).entries()) }) });
}

export function methodNotAllowed(allowed: string[]): Response {
  return json({ error: { code: "method_not_allowed", message: "Method not allowed" } }, 405, { Allow: allowed.join(", ") });
}

export async function readJson<T>(request: Request, maxBytes = 32_768): Promise<T> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (declaredLength > maxBytes) throw new HttpError(413, "payload_too_large", "Request body is too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new HttpError(413, "payload_too_large", "Request body is too large");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "invalid_json", "Malformed JSON body");
  }
}

export function requireSameOrigin(request: Request, env: Env): void {
  const expected = normalizeBaseUrl(env.PUBLIC_BASE_URL);
  const origin = request.headers.get("Origin");
  if (origin !== expected) throw new HttpError(403, "csrf_rejected", "Request origin was rejected");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite && fetchSite !== "same-origin") throw new HttpError(403, "csrf_rejected", "Cross-site request was rejected");
}

export function requestNonce(): string {
  return randomToken(18);
}

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
}
