/**
 * Environment resolution + validation.
 *
 * Zeus reads `env.X` inline in ~200 places and silently degrades when a binding
 * is missing (see the `catch (e) {}` around the gfx setting lookup). Kaveh
 * resolves the whole environment once, per request, into a typed object with
 * defaults, and fails loudly at boot if something critical is wrong.
 */

export const DEFAULTS = Object.freeze({
  panelName: "Kaveh",
  subPrefix: "s",
  defaultQuotaGb: 50,
  defaultExpiryDays: 30,
  fragmentPreset: "mci",
  logLevel: "info",
  sessionTtlMs: 1000 * 60 * 60 * 12,
  maxLoginAttempts: 8,
  loginWindowMs: 1000 * 60 * 10,
  dohResolver: "https://cloudflare-dns.com/dns-query",
  connectTimeoutMs: 8000,
});

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

/** @param {any} env Cloudflare env bindings + vars */
export function resolveEnv(env) {
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const resolved = {
    raw: env,
    db: env?.DB ?? null,
    ledger: env?.LEDGER ?? null,
    guard: env?.GUARD ?? null,
    cache: env?.CACHE ?? null,
    assets: env?.ASSETS ?? null,
    secret: env?.SECRET ?? null,
    config: Object.freeze({
      panelName: String(env?.PANEL_NAME ?? DEFAULTS.panelName),
      subPrefix: String(env?.SUB_PATH_PREFIX ?? DEFAULTS.subPrefix),
      defaultQuotaGb: num(env?.DEFAULT_QUOTA_GB, DEFAULTS.defaultQuotaGb),
      defaultExpiryDays: num(env?.DEFAULT_EXPIRY_DAYS, DEFAULTS.defaultExpiryDays),
      fragmentPreset: String(env?.FRAGMENT_PRESET ?? DEFAULTS.fragmentPreset),
      logLevel: String(env?.LOG_LEVEL ?? DEFAULTS.logLevel),
      sessionTtlMs: num(env?.SESSION_TTL_MS, DEFAULTS.sessionTtlMs),
      maxLoginAttempts: num(env?.MAX_LOGIN_ATTEMPTS, DEFAULTS.maxLoginAttempts),
      loginWindowMs: num(env?.LOGIN_WINDOW_MS, DEFAULTS.loginWindowMs),
      dohResolver: String(env?.DOH_RESOLVER ?? DEFAULTS.dohResolver),
      connectTimeoutMs: num(env?.CONNECT_TIMEOUT_MS, DEFAULTS.connectTimeoutMs),
      // Off by default. Turn on temporarily to see WHY a 500 happened:
      //   wrangler.toml → [vars] DEBUG_ERRORS = "1"   (then put it back to "0")
      // It is a var, not a secret, so it is obvious in the config review.
      debugErrors: String(env?.DEBUG_ERRORS ?? "") === "1",
    }),
  };
  resolved.log = createLogger(resolved.config.logLevel);
  return resolved;
}

/**
 * Missing bindings are a *deployment* error, not a runtime mystery.
 *
 * `SECRET` is deliberately NOT in this list any more: without it the Worker
 * generates and stores its own session signing key (src/core/keys.js), so a
 * dashboard or "Deploy with Workers" deployment boots instead of returning a
 * 503 the operator cannot act on from a phone. Setting SECRET still overrides it
 * and is the recommended path for CLI deploys.
 */
export function assertReady(E) {
  const missing = [];
  if (!E.db) missing.push("D1 binding `DB` — check the [[d1_databases]] block in wrangler.toml");
  if (missing.length) {
    throw new BootError(
      `Kaveh is not configured. Missing: ${missing.join(", ")}. ` +
        `See README.md → "نصب".`,
    );
  }
}

export class BootError extends Error {
  constructor(message) {
    super(message);
    this.name = "BootError";
    this.status = 503;
  }
}

export function createLogger(level = "info") {  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, msg, meta) => {
    if (LEVELS[lvl] > threshold) return;
    // Structured, JSON-line logs. Workers logs + `wrangler tail` both parse this,
    // and observability can forward it anywhere. Zeus logs nothing at all.
    console.log(JSON.stringify({ t: Date.now(), lvl, msg, ...(meta || {}) }));
  };
  return {
    error: (m, meta) => emit("error", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    info: (m, meta) => emit("info", m, meta),
    debug: (m, meta) => emit("debug", m, meta),
  };
}

/**
 * Durable Object stub helper.
 *
 * The binding is the namespace: `env.LEDGER.get(id)` returns the stub.
 * `id.get()` does not exist — calling it throws `doId.get is not a function`
 * at runtime, which is exactly the kind of bug a real `wrangler dev` catches
 * and reading the code does not.
 *
 * @param {DurableObjectNamespace|undefined|null} ns
 * @param {string} name  stable key — the same name always maps to the same object
 * @returns {DurableObjectStub|null}  null when the binding is absent, so callers
 *          can degrade gracefully instead of taking the whole panel down
 */
export function doStub(ns, name) {
  if (!ns) return null;
  return ns.get(ns.idFromName(name));
}
