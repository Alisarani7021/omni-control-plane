/**
 * Session signing key — and why `SECRET` became optional.
 *
 * Signing sessions with an HMAC key is non-negotiable. Requiring the operator to
 * run `wrangler secret put SECRET` before the panel will boot is not: it makes
 * the difference between "tap a button on your phone" and "install Node, learn a
 * CLI, and get the ordering right" — and getting it wrong means a 503 with a
 * message most people cannot act on.
 *
 * So: if `SECRET` is set, it is used (still recommended for CLI deploys, because
 * it survives a database restore and lets you rotate sessions deliberately). If
 * it is not, Kaveh generates a 256-bit key with Web Crypto on first boot and
 * stores it in D1, using `INSERT OR IGNORE` so two racing isolates converge on
 * the same winner instead of each minting their own and invalidating each
 * other's cookies.
 *
 * Threat model, stated plainly: an attacker who can read this row can also read
 * every user, quota and password hash in the same database — so the fallback
 * does not create a new class of exposure, it just declines to pretend the DB is
 * a secret from people who already own it. The row is redacted from every API
 * response (REDACTED_KEYS) and rejected as a write target, so it cannot be
 * exfiltrated or clobbered through the panel itself.
 */

/** Keys that must never leave the Worker, nor be settable through the API. */
export const REDACTED_KEYS = Object.freeze(["admin_hash", "signing_key", "cf_api_token", "secret"]);

const KEY_ROW = "signing_key";
let cached = null;

function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @returns {Promise<string>} the HMAC key for this deployment */
export async function signingKey(E) {
  if (E.secret) return E.secret;
  if (cached) return cached;

  const candidate = newKey();
  await E.db
    .prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(KEY_ROW, candidate, Date.now())
    .run();
  const row = await E.db.prepare("SELECT value FROM settings WHERE key = ?").bind(KEY_ROW).first();
  cached = row?.value || null;
  if (!cached) throw new Error("could not establish a session signing key");

  E.log?.warn("signing_key.generated", {
    hint: "SECRET is not set; using a generated key stored in D1. Set it with `wrangler secret put SECRET` to pin your own.",
  });
  return cached;
}

/** Strip keys that must not travel to a browser. Mutates and returns the copy. */
export function redactSettings(obj) {
  const out = { ...(obj || {}) };
  for (const k of REDACTED_KEYS) delete out[k];
  return out;
}

/** Test hook. */
export function resetKeyCache() {
  cached = null;
}
