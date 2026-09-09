import { audit, rateLimit, requireSession } from "./db";
import { HttpError, redirect } from "./http";
import {
  addSecondsIso,
  clearSessionCookie,
  nowIso,
  parsePositiveInt,
  randomToken,
  sessionCookie,
  sha256,
} from "./security";
import type { Env, SessionPrincipal } from "./types";

export const SESSION_COOKIE = "v13_session";

export async function loginFromOneTimeLink(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("t") ?? "";
  if (token.length < 32 || token.length > 128) throw new HttpError(400, "invalid_login_link", "Login link is invalid or expired");
  const tokenHash = await sha256(token);
  const link = await env.DB.prepare(
    "SELECT tenant_id, expires_at, consumed_at FROM login_links WHERE token_hash = ?",
  ).bind(tokenHash).first<{ tenant_id: string; expires_at: string; consumed_at: string | null }>();
  if (!link || link.consumed_at || Date.parse(link.expires_at) <= Date.now()) {
    throw new HttpError(400, "invalid_login_link", "Login link is invalid or expired");
  }
  const consumed = await env.DB.prepare(
    "UPDATE login_links SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL",
  ).bind(nowIso(), tokenHash).run();
  if ((consumed.meta.changes ?? 0) !== 1) throw new HttpError(409, "login_link_used", "Login link was already used");

  const rawSession = randomToken(32);
  const sessionHash = await sha256(rawSession);
  const ttl = parsePositiveInt(env.SESSION_TTL_SECONDS, 2_592_000, 7_776_000);
  const userAgentHash = await sha256(request.headers.get("User-Agent") ?? "unknown");
  await env.DB.prepare(
    `INSERT INTO sessions (session_hash, tenant_id, expires_at, created_at, last_seen_at, user_agent_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(sessionHash, link.tenant_id, addSecondsIso(ttl), nowIso(), nowIso(), userAgentHash).run();
  await audit(env, {
    tenantId: link.tenant_id,
    actorType: "user",
    actorId: link.tenant_id,
    action: "session.create",
    outcome: "success",
    request,
  });
  return redirect("/app", 303, { "Set-Cookie": sessionCookie(rawSession, ttl) });
}

export async function logout(request: Request, env: Env, principal: SessionPrincipal): Promise<Response> {
  await env.DB.prepare("DELETE FROM sessions WHERE session_hash = ?").bind(principal.sessionHash).run();
  await audit(env, {
    tenantId: principal.tenantId,
    actorType: "user",
    actorId: principal.telegramUserId,
    action: "session.revoke",
    outcome: "success",
    request,
  });
  return redirect("/", 303, { "Set-Cookie": clearSessionCookie() });
}

export async function authenticated(request: Request, env: Env): Promise<SessionPrincipal> {
  const principal = await requireSession(request, env);
  if (!principal) throw new HttpError(401, "authentication_required", "Open a fresh link from the Telegram bot");
  return principal;
}

export async function loginRateLimit(request: Request, env: Env): Promise<void> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const allowed = await rateLimit(env, `login:${await sha256(ip)}`, 20, 60);
  if (!allowed) throw new HttpError(429, "rate_limited", "Too many attempts");
}
