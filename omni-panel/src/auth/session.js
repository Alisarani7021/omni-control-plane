/**
 * Password hashing + session cookies, using only WebCrypto.
 *
 * Zeus stores a bare SHA-256 of the panel password. Unsalted SHA-256 of a
 * password is a GPU-crackable rainbow-table lookup — a 6-character password is
 * gone in milliseconds. Kaveh uses PBKDF2-SHA256 with a per-admin random salt,
 * plus short-lived HMAC-signed session cookies.
 *
 * ── WHY 2 × 100k AND NOT 210k ───────────────────────────────────────────────
 * The first version of this file asked for 210,000 iterations (OWASP's 2023
 * figure for PBKDF2-HMAC-SHA256). It passed every local test, then failed on the
 * first real deploy with:
 *
 *   NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
 *   supported (requested 210000).
 *
 * workerd caps a single PBKDF2 call at 100k iterations. Node's WebCrypto does
 * not, which is why `wrangler dev` and the unit tests could never catch it —
 * only a real deployment could. Measured on the production runtime: 100k
 * succeeds, 150k throws.
 *
 * So the work is split across two chained calls (200k total, each under the
 * cap), with the round index mixed into the salt so round two is not a re-run of
 * round one over identical inputs. The parameters are stored IN the hash string
 * (`pbkdf2$2x100000$salt$hash`), and the old single-call format still verifies,
 * so nobody gets locked out by this change.
 */
import { unauthorized, forbidden } from "../core/errors.js";
import { signingKey } from "../core/keys.js";

/** Hard ceiling of one PBKDF2 call in workerd. Do not raise it — see above. */
export const PBKDF2_MAX_ITERATIONS = 100_000;
export const PBKDF2_ITERATIONS = PBKDF2_MAX_ITERATIONS;
export const PBKDF2_ROUNDS = 2;
const enc = new TextEncoder();

const b64u = {
  encode(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  },
  decode(str) {
    const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
    const bin = atob(str.replaceAll("-", "+").replaceAll("_", "/") + pad);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

async function pbkdf2(input, salt, iterations) {
  if (iterations > PBKDF2_MAX_ITERATIONS) {
    // Fail loudly here rather than inside workerd with a message that does not
    // say which of our parameters was illegal.
    throw new Error(`PBKDF2 iterations ${iterations} exceed the workerd cap of ${PBKDF2_MAX_ITERATIONS}`);
  }
  const key = await crypto.subtle.importKey("raw", input, "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256),
  );
}

/** Chained derivation: `rounds` calls, each under the cap, output feeding input. */
async function derive(password, salt, rounds, iterations) {
  let input = enc.encode(password);
  let out = new Uint8Array(32);
  for (let r = 0; r < rounds; r++) {
    const rs = new Uint8Array(salt.length + 1);
    rs.set(salt, 0);
    rs[salt.length] = r & 0xff; // domain separation per round
    out = await pbkdf2(input, rs, iterations);
    input = out;
  }
  return out;
}

/** Legacy single-call scheme, kept only so existing hashes still verify. */
async function deriveLegacy(password, salt, iterations) {
  return pbkdf2(enc.encode(password), salt, iterations);
}

export async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const bits = await derive(password, salt, PBKDF2_ROUNDS, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ROUNDS}x${PBKDF2_ITERATIONS}$${b64u.encode(salt)}$${b64u.encode(bits)}`;
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const [, params, saltB64, hashB64] = parts;
  const salt = b64u.decode(saltB64);
  // `2x100000` = chained scheme; a bare number = the legacy single call.
  const [rounds, iters] = params.includes("x")
    ? params.split("x").map(Number)
    : [1, Number(params)];
  // Anything the runtime cannot compute is simply not a match — it must never
  // throw, or a tampered/garbage row in `settings` turns every login into a 500.
  // (A pre-fix `pbkdf2$210000$…` row lands here: it was never creatable on
  // workerd, so it can only exist in a local dev database.)
  if (![rounds, iters].every((n) => Number.isInteger(n) && n > 0) || iters > PBKDF2_MAX_ITERATIONS || rounds > 64) {
    return false;
  }
  const a = params.includes("x")
    ? await derive(password, salt, rounds, iters)
    : await deriveLegacy(password, salt, iters);
  const b = b64u.decode(hashB64);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export const SESSION_COOKIE = "kaveh_session";

/**
 * Signed cookie: `payload.signature`, payload = base64url(JSON).
 * Stateless verification (no D1 read per request) + a server-side row so
 * sessions can be revoked instantly from the panel.
 */
export async function createSession(E, { subject, role = "admin", ip = null, ua = null, ttlMs = E.config.sessionTtlMs }) {
  const now = Date.now();
  const id = crypto.randomUUID();
  const payload = { id, sub: subject, role, exp: now + ttlMs, iat: now };
  const body = b64u.encode(enc.encode(JSON.stringify(payload)));
  const sig = b64u.encode(await hmac(await signingKey(E), body));
  await E.db
    .prepare("INSERT INTO sessions (id,subject,role,created_at,expires_at,ip_hash,ua_hash) VALUES (?,?,?,?,?,?,?)")
    .bind(id, subject, role, now, now + ttlMs, ip ? await sha8(ip) : null, ua ? await sha8(ua) : null)
    .run();
  return { id, token: `${body}.${sig}`, expiresAt: now + ttlMs };
}

export async function verifySession(E, cookieHeader) {
  if (!cookieHeader) return null;
  const raw = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!raw) return null;
  const token = raw.slice(SESSION_COOKIE.length + 1);
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expect = b64u.encode(await hmac(await signingKey(E), body));
  if (!timingSafeEqual(b64u.decode(expect), b64u.decode(sig))) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64u.decode(body)));
  } catch {
    return null;
  }
  if (!payload?.exp || payload.exp < Date.now()) return null;
  // Revocation check: one indexed read. Worth it — "logout everywhere" must work.
  const row = await E.db.prepare("SELECT id FROM sessions WHERE id = ? AND expires_at > ?").bind(payload.id, Date.now()).first();
  if (!row) return null;
  return { id: payload.id, subject: payload.sub, role: payload.role };
}

export async function destroySession(E, id) {
  await E.db.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
}

export async function destroyAllSessions(E, subject = null) {
  await (subject
    ? E.db.prepare("DELETE FROM sessions WHERE subject = ?").bind(subject).run()
    : E.db.prepare("DELETE FROM sessions").run());
}

export async function purgeExpiredSessions(E) {
  await E.db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Date.now()).run();
}

async function sha8(s) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(String(s)));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function sessionCookie(token, { ttlSec, secure = true } = {}) {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    secure ? "Secure" : "",
    "SameSite=Strict",
    `Max-Age=${ttlSec}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function requireRole(session, ...roles) {
  if (!session) throw unauthorized();
  if (!roles.includes(session.role)) throw forbidden("دسترسی کافی ندارید");
}

export { b64u };
