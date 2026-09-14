import { hashPassword, verifyPassword, createSession, verifySession, destroySession, destroyAllSessions, purgeExpiredSessions, sessionCookie, clearSessionCookie, SESSION_COOKIE } from "../auth/session.js";

// Re-exported so the scheduled() handler in src/index.js has one import
// surface for everything auth-related. Without this, esbuild warns
// "Import will always be undefined" and the cron silently skips pruning.
export { purgeExpiredSessions };
import { Settings, audit } from "../db/index.js";
import { ok, json, readJson } from "../core/http.js";
import { badRequest, unauthorized, forbidden, tooMany } from "../core/errors.js";
import { doStub } from "../core/env.js";

const ADMIN_HASH_KEY = "admin_hash";
const ADMIN_USER_KEY = "admin_user";

/** POST /api/setup — first-run password creation. One-shot, then disabled. */
export async function setup(request, E, { ip }) {
  const S = new Settings(E);
  if (await S.get(ADMIN_HASH_KEY)) throw forbidden("پنل قبلاً راه‌اندازی شده است");
  const body = await readJson(request);
  const password = String(body.password || "");
  if (password.length < 10) throw badRequest("رمز عبور باید حداقل ۱۰ کاراکتر باشد");
  const username = String(body.username || "admin").slice(0, 32);
  const hash = await hashPassword(password);
  await S.set({
    [ADMIN_HASH_KEY]: hash,
    [ADMIN_USER_KEY]: username,
    installed_at: String(Date.now()),
    core_version: CORE_VERSION,
  });
  await audit(E, { actor: username, action: "setup", ip });
  const session = await createSession(E, { subject: username, role: "owner", ip, ua: request.headers.get("user-agent") });
  // The cookie goes on the RESPONSE, not in the JSON body — otherwise the very
  // first login leaves the admin unauthenticated and the panel looks broken.
  const res = ok({ username, message: "پنل ساخته شد. رمز عبور را جای امنی نگه دارید." });
  res.headers.set("set-cookie", sessionCookie(session.token, { ttlSec: Math.floor(E.config.sessionTtlMs / 1000) }));
  return res;
}

/** POST /api/login */
export async function login(request, E, { ip }) {
  const S = new Settings(E);
  const stored = await S.get(ADMIN_HASH_KEY);
  if (!stored) return json({ ok: false, code: "not_installed", error: "پنل هنوز راه‌اندازی نشده" }, 409);

  // Brute-force guard via the Guard Durable Object — globally consistent,
  // unlike an in-memory Map that resets every time the isolate is recycled.
  const guard = doStub(E.guard, "login");
  if (guard) {
    const res = await guard.fetch(`https://guard/hit?key=${encodeURIComponent(ip)}&limit=${E.config.maxLoginAttempts}&window=${Math.floor(E.config.loginWindowMs / 1000)}`);
    const j = await res.json();
    if (!j.allowed) throw tooMany(j.resetIn || 60);
  }

  const body = await readJson(request);
  const password = String(body.password || "");
  const subject = String(body.username || (await S.get(ADMIN_USER_KEY)) || "admin");
  const valid = await verifyPassword(password, stored);
  if (!valid) {
    await audit(E, { actor: subject, action: "login_failed", ip });
    throw unauthorized("رمز عبور اشتباه است");
  }
  if (guard) await guard.fetch(`https://guard/reset?key=${encodeURIComponent(ip)}`);
  const session = await createSession(E, { subject, role: "owner", ip, ua: request.headers.get("user-agent") });
  await audit(E, { actor: subject, action: "login", ip });
  const res = ok({ username: subject, role: "owner", expiresAt: session.expiresAt });
  res.headers.set("set-cookie", sessionCookie(session.token, { ttlSec: Math.floor(E.config.sessionTtlMs / 1000) }));
  return res;
}

export async function logout(request, E, ctx) {
  const session = ctx.session;
  if (session) await destroySession(E, session.id);
  const res = ok();
  res.headers.set("set-cookie", clearSessionCookie());
  return res;
}

export async function changePassword(request, E, ctx) {
  const body = await readJson(request);
  const S = new Settings(E);
  const current = String(body.current || "");
  const next = String(body.next || "");
  if (next.length < 10) throw badRequest("رمز جدید باید حداقل ۱۰ کاراکتر باشد");
  if (!(await verifyPassword(current, await S.get(ADMIN_HASH_KEY)))) throw unauthorized("رمز فعلی اشتباه است");
  await S.set({ [ADMIN_HASH_KEY]: await hashPassword(next) });
  // Every existing session is invalidated — an attacker with a stolen cookie
  // cannot ride out the password change.
  await destroyAllSessions(E);
  await audit(E, { actor: ctx.session?.subject, action: "change_password", ip: ctx.ip });
  const res = ok({ message: "رمز عبور تغییر کرد. دوباره وارد شوید." });
  res.headers.set("set-cookie", clearSessionCookie());
  return res;
}

/** POST /api/recover — only works if the Cloudflare account owner set RECOVERY_CODE. */
export async function recover(request, E, { ip }) {
  const expected = E.raw?.RECOVERY_CODE;
  if (!expected) throw forbidden("بازیابی رمز غیرفعال است. متغیر RECOVERY_CODE را در wrangler.toml یا داشبورد کلودفلر تنظیم کنید.");
  const body = await readJson(request);
  if (String(body.code || "") !== String(expected)) {
    await audit(E, { actor: "unknown", action: "recover_failed", ip });
    throw unauthorized("کد بازیابی اشتباه است");
  }
  const next = String(body.password || "");
  if (next.length < 10) throw badRequest("رمز جدید باید حداقل ۱۰ کاراکتر باشد");
  const S = new Settings(E);
  await S.set({ [ADMIN_HASH_KEY]: await hashPassword(next) });
  await destroyAllSessions(E);
  await audit(E, { actor: "recovery", action: "recover", ip });
  return ok({ message: "رمز عبور بازنشانی شد" });
}

export async function whoami(request, E, ctx) {
  const S = new Settings(E);
  return ok({
    username: ctx.session?.subject ?? null,
    role: ctx.session?.role ?? null,
    panelName: await S.get("panel_name", E.config.panelName),
    installed: !!(await S.get(ADMIN_HASH_KEY)),
    version: CORE_VERSION,
  });
}

export async function listSessions(request, E, ctx) {
  const { results } = await E.db
    .prepare("SELECT id, subject, role, created_at, expires_at, ip_hash, ua_hash FROM sessions ORDER BY created_at DESC LIMIT 50")
    .all();
  return ok({ sessions: results });
}

export async function revokeSession(request, E, ctx) {
  const body = await readJson(request);
  if (body.all) {
    await destroyAllSessions(E, ctx.session?.subject);
    await purgeExpiredSessions(E);
  } else {
    await destroySession(E, String(body.id));
  }
  await audit(E, { actor: ctx.session?.subject, action: "revoke_session", ip: ctx.ip, detail: { all: !!body.all } });
  return ok();
}

/** Shared auth check used by the middleware. */
export async function authenticate(request, E) {
  const cookie = request.headers.get("cookie");
  if (!cookie?.includes(SESSION_COOKIE)) return null;
  return verifySession(E, cookie);
}

export const CORE_VERSION = "0.1.0";
