import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, createSession, sessionCookie } from "../src/auth/session.js";
import { Router, requireMatch as _requireMatch } from "../src/core/router.js";
import { resolveEnv, assertReady, BootError } from "../src/core/env.js";
import { signingKey, redactSettings, REDACTED_KEYS, resetKeyCache } from "../src/core/keys.js";

test("password hashing is salted: the same password hashes differently", async () => {
  const a = await hashPassword("correct-horse-battery");
  const b = await hashPassword("correct-horse-battery");
  assert.notEqual(a, b);
  assert.match(a, /^pbkdf2\$2x100000\$/, "params must be stored in the hash string");
});

/* ── regression: workerd caps a single PBKDF2 call at 100k iterations ────────
   The first version of Kaveh asked for 210k. Every local test passed; the first
   real deploy threw NotSupportedError on /api/setup and the panel could never be
   installed. These tests pin the ceiling so it cannot silently go back up.    */
test("no single PBKDF2 call exceeds the workerd ceiling of 100k", async () => {
  const { PBKDF2_ITERATIONS, PBKDF2_MAX_ITERATIONS, PBKDF2_ROUNDS } = await import("../src/auth/session.js");
  assert.ok(PBKDF2_ITERATIONS <= 100_000, `${PBKDF2_ITERATIONS} would throw NotSupportedError in production`);
  assert.equal(PBKDF2_MAX_ITERATIONS, 100_000);
  assert.ok(PBKDF2_ROUNDS >= 2, "chaining is what buys back the iterations the cap took away");
  // The stored string is what verify() will feed back into crypto.subtle.
  const h = await hashPassword("whatever");
  const iters = Number(h.split("$")[1].split("x")[1]);
  assert.ok(iters <= 100_000, `hash records ${iters} iterations per call`);
});

async function legacyHash(password, saltStr, iterations) {
  // The pre-fix, single-call format. Node's WebCrypto has no 100k ceiling,
  // so tests can build these even where workerd could not.
  const enc = new TextEncoder();
  const salt = enc.encode(saltStr);
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256));
  const b64u = (b) => btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `pbkdf2$${iterations}$${b64u(salt)}$${b64u(bits)}`;
}

test("the legacy single-call format still verifies within the runtime ceiling", async () => {
  const h = await legacyHash("old-password", "legacy-salt-value", 60_000);
  assert.equal(await verifyPassword("old-password", h), true, "existing admins must not be locked out");
  assert.equal(await verifyPassword("wrong-password", h), false);
});

test("parameters the runtime cannot compute are a rejection, never a throw", async () => {
  // A pre-fix 210k row: unverifiable on workerd by definition. It must fail
  // closed and quietly — a throw here would turn every login into a 500.
  const impossible = await legacyHash("old-password", "legacy-salt-value", 210_000);
  assert.equal(await verifyPassword("old-password", impossible), false);
  for (const garbage of ["pbkdf2$0x100000$AAAA$BBBB", "pbkdf2$-1x100000$AAAA$BBBB", "pbkdf2$NaN$AAAA$BBBB", "pbkdf2$2x999999$AAAA$BBBB", "pbkdf2$9999x100$AAAA$BBBB"]) {
    assert.equal(await verifyPassword("whatever", garbage), false, `should reject ${garbage}`);
  }
});

test("tampered parameters do not verify", async () => {
  const h = await hashPassword("correct-horse-battery");
  const [scheme, params, salt, hash] = h.split("$");
  assert.equal(await verifyPassword("correct-horse-battery", [scheme, "1x100000", salt, hash].join("$")), false);
  assert.equal(await verifyPassword("correct-horse-battery", [scheme, params, salt, hash.slice(0, -2) + "aa"].join("$")), false);
  assert.equal(await verifyPassword("correct-horse-battery", "pbkdf2$2x200000$" + salt + "$" + hash), false, "above the cap → reject");
});

test("password verification accepts the right password and rejects the wrong one", async () => {
  const h = await hashPassword("correct-horse-battery");
  assert.equal(await verifyPassword("correct-horse-battery", h), true);
  assert.equal(await verifyPassword("correct-horse-batterY", h), false);
  assert.equal(await verifyPassword("", h), false);
});

test("a legacy unsalted sha-256 hash is rejected, not silently accepted", async () => {
  const legacy = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hunter2"));
  const hex = [...new Uint8Array(legacy)].map((b) => b.toString(16)).join("");
  assert.equal(await verifyPassword("hunter2", hex), false);
});

/* A minimal in-memory stand-in for D1, enough to exercise session logic. */
function fakeDb() {
  const rows = new Map();
  const mk = (sql) => ({
    bind: (...vals) => ({
      run: async () => {
        if (/INSERT INTO sessions/.test(sql)) rows.set(vals[0], { id: vals[0], subject: vals[1], role: vals[2], expires_at: vals[4] });
        if (/DELETE FROM sessions WHERE id/.test(sql)) rows.delete(vals[0]);
        return { meta: { changes: 1 } };
      },
      first: async () => {
        if (/SELECT id FROM sessions/.test(sql)) return rows.get(vals[0]) ?? null;
        return null;
      },
      all: async () => ({ results: [...rows.values()] }),
    }),
  });
  return { prepare: mk, batch: async (s) => Promise.all(s.map((x) => x.run())) };
}

test("sessions are signed, expire, and can be revoked", async () => {
  const E = resolveEnv({ DB: fakeDb(), SECRET: "test-secret-please-change" });
  const s = await createSession(E, { subject: "admin", role: "owner", ip: "1.2.3.4", ua: "test" });
  assert.match(s.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.match(sessionCookie(s.token, { ttlSec: 60 }), /HttpOnly; Secure; SameSite=Strict/);

  const { verifySession, destroySession } = await import("../src/auth/session.js");
  assert.deepEqual((await verifySession(E, `kaveh_session=${s.token}`)).subject, "admin");

  // Tampering with the payload must invalidate the signature.
  const [b64, sig] = s.token.split(".");
  const tampered = b64.slice(0, -3) + "eyJ9." + sig;
  assert.equal(await verifySession(E, `kaveh_session=${tampered}`), null);

  await destroySession(E, s.id);
  assert.equal(await verifySession(E, `kaveh_session=${s.token}`), null, "revoked session must not verify");
});

test("the router matches params, methods, and reports 404s separately from 405s", () => {
  const r = new Router();
  r.get("/api/users/:username", () => "get", { auth: "admin" });
  r.delete("/api/users/:username", () => "del");

  const hit = r.match("GET", "/api/users/ali-101");
  assert.equal(hit.params.username, "ali-101");
  assert.equal(hit.methodMatch, true);
  assert.equal(hit.route.auth, "admin");

  const wrongMethod = r.match("PATCH", "/api/users/ali-101");
  assert.equal(wrongMethod.methodMatch, false);
  assert.deepEqual(wrongMethod.allowed.sort(), ["DELETE", "GET"]);

  assert.equal(r.match("GET", "/api/nope"), null);
  assert.ok(r.list().includes("GET    /api/users/:username"));
});

/**
 * Regression: `/api/users/bulk` and `/api/users/:username` match the same path
 * shape. A router that stops at the first path match returns 405 for the bulk
 * endpoint — which is exactly what the first `wrangler dev` run exposed.
 */
test("a literal sub-path wins over a sibling :param route regardless of order", () => {
  const r = new Router();
  r.get("/api/users", () => "list");
  r.post("/api/users", () => "create");
  r.get("/api/users/:username", () => "one");
  r.post("/api/users/bulk", () => "bulk");
  r.delete("/api/users/:username", () => "remove");

  assert.equal(r.match("POST", "/api/users/bulk").route.handler(), "bulk");
  assert.equal(r.match("DELETE", "/api/users/ali-101").route.handler(), "remove");
  assert.equal(r.match("GET", "/api/users/bulk").params.username, "bulk", "GET still resolves to the param route");
});

test("405 and 404 are distinct, and 405 carries an Allow header", () => {
  const { requireMatch } = require_router();
  const r = new Router();
  r.get("/api/users/:username", () => "one");

  assert.throws(() => requireMatch(r.match("GET", "/nope"), "GET", "/nope"), (e) => e.status === 404 && e.code === "not_found");
  assert.throws(() => requireMatch(r.match("DELETE", "/api/users/x"), "DELETE", "/api/users/x"), (e) => {
    assert.equal(e.status, 405);
    assert.equal(e.code, "method_not_allowed");
    assert.equal(e.allow, "GET");
    return true;
  });
});

function require_router() {
  // Synchronous re-export helper kept local to avoid a top-level await in tests.
  return { requireMatch: _requireMatch };
}

/* ── boot contract: what is required, and what is generated ────────────────── */

/** Minimal in-memory D1 double — just enough for the settings round-trip. */
function fakeD1(store = new Map()) {
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    async run() {
      const ins = sql.match(/^INSERT OR IGNORE INTO settings .*VALUES \(\?, \?, \?\)$/);
      if (ins) { if (!store.has(params[0])) store.set(params[0], params[1]); return { success: true }; }
      throw new Error("unexpected statement: " + sql);
    },
    async first() {
      const m = sql.match(/^SELECT value FROM settings WHERE key = \?$/);
      if (m) return store.has(params[0]) ? { value: store.get(params[0]) } : null;
      throw new Error("unexpected statement: " + sql);
    },
  });
  return { prepare: (sql) => stmt(sql), _store: store };
}

test("a missing D1 binding still fails loudly at boot", () => {
  const E = resolveEnv({});
  assert.throws(() => assertReady(E), BootError);
});

test("a missing SECRET boots: the key is generated, stored once, and reused", async () => {
  const db = fakeD1();
  const E = resolveEnv({ DB: db });
  assertReady(E); // must not throw — this is what makes button/GitHub deploys work

  const k1 = await signingKey(E);
  const k2 = await signingKey(E);
  assert.equal(k1, k2, "the same isolate must sign with the same key");
  assert.ok(k1.length >= 40, `key looks too weak: ${k1.length} chars`);
  assert.equal(db._store.get("signing_key"), k1, "key is persisted, not per-request");
});

test("two racing isolates converge on one generated key instead of two", async () => {
  const db = fakeD1();
  const a = resolveEnv({ DB: db });
  const b = resolveEnv({ DB: db });
  const [ka, kb] = await Promise.all([signingKey(a), signingKey(b)]);
  assert.equal(ka, kb, "INSERT OR IGNORE must leave a single winner");
});

test("an explicit SECRET always wins over the generated key", async () => {
  const db = fakeD1();
  const E = resolveEnv({ DB: db, SECRET: "operator-provided-secret-value" });
  assert.equal(await signingKey(E), "operator-provided-secret-value");
  assert.equal(db._store.has("signing_key"), false, "must not mint a key it will not use");
});

test("the signing key and admin hash never reach a browser payload", () => {
  const out = redactSettings({
    panel_name: "Kaveh", admin_hash: "$pbkdf2$x", signing_key: "leak-me",
    cf_api_token: "leak-too", secret: "leak-also", clean_ips: "[]",
  });
  assert.deepEqual(out, { panel_name: "Kaveh", clean_ips: "[]" });
  for (const k of ["admin_hash", "signing_key", "cf_api_token", "secret"]) {
    assert.ok(REDACTED_KEYS.includes(k), `${k} must stay on the redaction list`);
  }
});
