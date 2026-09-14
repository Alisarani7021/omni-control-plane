/**
 * D1 access layer.
 *
 * Two things Zeus gets wrong and this fixes:
 *
 * 1. Zeus calls `CREATE TABLE IF NOT EXISTS` on *every request* (`ensureSchema`)
 *    — that's 10+ wasted D1 statements before your panel even answers, eating
 *    the free tier's 100k rows/day. Kaveh migrates once, at deploy time, with
 *    `wrangler d1 migrations apply`, and records the version in a table.
 *
 * 2. Zeus writes traffic counters from in-memory Maps with a hand-rolled
 *    `GLOBAL_WRITE_LOCK`. When the isolate is evicted (which happens constantly
 *    at the edge) those numbers vanish — users get free traffic, and your
 *    dashboard shows numbers that were never true. Kaveh routes every byte
 *    through a Durable Object ledger that flushes in batches.
 */

/** @param {import("../core/env.js").ResolvedEnv} E */
export async function ensureMigrated(E) {
  const row = await E.db.prepare("SELECT value FROM settings WHERE key='schema_version'").first();
  if (row) return row.value;
  // Only ever runs once per database, on the first request after a fresh deploy.
  await E.db
    .batch([
      E.db.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('schema_version','1',?)").bind(Date.now()),
    ])
    .catch((e) => E.log.warn("schema_version write failed", { e: String(e?.message || e) }));
  return "1";
}

export const stmt = (E, sql, ...bind) => E.db.prepare(sql).bind(...bind);

/** Batch helper: one round-trip for N statements. */
export async function batch(E, statements) {
  if (!statements.length) return [];
  const results = [];
  // D1 allows max 100 statements per batch — chunk defensively.
  for (let i = 0; i < statements.length; i += 100) {
    results.push(...(await E.db.batch(statements.slice(i, i + 100))));
  }
  return results;
}

/**
 * Key/value settings store with an in-request cache.
 * Settings are read on nearly every request; caching per-request turns ~6 D1
 * reads into 1.
 */
export class Settings {
  #E;
  #cache = new Map();
  constructor(E) {
    this.#E = E;
  }
  async all() {
    if (this.#cache.size) return Object.fromEntries(this.#cache);
    const { results } = await this.#E.db.prepare("SELECT key, value FROM settings").all();
    this.#cache = new Map(results.map((r) => [r.key, r.value]));
    return Object.fromEntries(this.#cache);
  }
  async get(key, fallback = null) {
    if (!this.#cache.size) await this.all();
    const v = this.#cache.get(key);
    return v === undefined ? fallback : v;
  }
  async getJson(key, fallback) {
    const raw = await this.get(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  async set(entries) {
    const now = Date.now();
    const list = Object.entries(entries);
    await batch(
      this.#E,
      list.map(([k, v]) =>
        this.#E.db
          .prepare(
            "INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
          )
          .bind(k, typeof v === "string" ? v : JSON.stringify(v), now),
      ),
    );
    for (const [k, v] of list) this.#cache.set(k, typeof v === "string" ? v : JSON.stringify(v));
    return Object.fromEntries(this.#cache);
  }
}

/** SHA-256 of an IP, truncated. We log a hash, never the raw IP. */
export async function hashIp(ip) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(ip)));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Append-only audit trail. Zeus has none: when a reseller deletes 40 users, or
 * someone changes the clean-IP list, there is no record of who or when.
 */
export async function audit(E, { actor, action, target = null, ip = null, detail = null }) {
  try {
    await E.db
      .prepare("INSERT INTO audit_log (at,actor,action,target,ip_hash,detail) VALUES (?,?,?,?,?,?)")
      .bind(Date.now(), String(actor || "system"), action, target, ip ? await hashIp(ip) : null, detail ? JSON.stringify(detail).slice(0, 2000) : null)
      .run();
  } catch (e) {
    E.log.warn("audit write failed", { action, e: String(e?.message || e) });
  }
}
