/**
 * Boot-time schema provisioning.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The canonical path is still `wrangler d1 migrations apply kaveh --remote`.
 * But that command needs a terminal, and — as of wrangler 4.86 — it cannot even
 * resolve an auto-provisioned database from a TOML config (workers-sdk#13632:
 * "missing a database_id, which is needed for operations on remote resources").
 *
 * That matters because Wrangler ≥ 4.45 can create the D1 database for you when
 * `database_id` is omitted — including when you deploy from the dashboard or a
 * "Deploy with Workers" button on a phone. The database appears, empty, with no
 * way to run migrations from the same flow. So the panel would be dead on
 * arrival for exactly the users who need it most.
 *
 * WHAT THIS IS NOT
 * ────────────────
 * It is not Zeus's approach. Zeus fires `CREATE TABLE IF NOT EXISTS` on *every
 * request*, forever, which is why its schema cannot be versioned or reasoned
 * about. Here:
 *   • migrations stay in numbered SQL files (`schema/000N_*.sql`) — the same
 *     files `wrangler d1 migrations apply` uses, so there is one source of truth
 *   • a `schema_meta` table records which versions have run
 *   • the probe runs at most once per isolate (module-level latch), costing a
 *     single indexed read, then never again
 *   • CLI users who ran the migrations pay for one no-op read on cold start
 */
import SCHEMA_0001 from "../../schema/0001_init.sql";

/** Ordered, additive. Never edit an applied migration — append a new file. */
export const MIGRATIONS = Object.freeze([{ v: 1, name: "0001_init", sql: SCHEMA_0001 }]);

const META_DDL = "CREATE TABLE IF NOT EXISTS schema_meta (v INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER NOT NULL)";

/** Module-level latch: one probe per isolate, not per request. */
let provisioned = false;

/**
 * Split a migration file into executable statements.
 *
 * Deliberately simple, because the migrations are deliberately simple: `--`
 * line comments, no triggers, no `BEGIN…END` bodies, no string literals
 * containing semicolons. If a future migration needs a trigger, this must
 * become a real parser — `test/migrate.test.js` fails loudly if someone adds a
 * semicolon inside a statement without teaching the splitter about it.
 */
export function splitStatements(sql) {
  return sql
    .split("\n")
    .map((line) => {
      // Strip full-line comments. A trailing `-- …` after code is kept, because
      // stripping it naively would also eat `--` inside string literals.
      const t = line.trim();
      return t.startsWith("--") ? "" : line;
    })
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^\s*--/.test(s));
}

/**
 * Make sure the schema matches the migrations shipped with this build.
 * @returns {Promise<{applied: number[], skipped: boolean}>}
 */
export async function ensureSchema(E) {
  if (provisioned) return { applied: [], skipped: true };
  if (!E.db) throw new Error("ensureSchema: no D1 binding");

  await E.db.prepare(META_DDL).run();
  const { results } = await E.db.prepare("SELECT v FROM schema_meta").all();
  const have = new Set((results || []).map((r) => Number(r.v)));
  const todo = MIGRATIONS.filter((m) => !have.has(m.v));

  if (!todo.length) {
    provisioned = true;
    return { applied: [], skipped: false };
  }

  for (const m of todo) {
    // NOTE: `db.batch()` takes *statement objects*, not promises. Calling
    // `.run()` here would execute every statement immediately and then hand
    // batch() a list of resolved promises — which "works" by accident against a
    // real D1 and fails confusingly against anything else. The unit test caught
    // exactly this.
    const statements = splitStatements(m.sql).map((sql) => E.db.prepare(sql));
    statements.push(E.db.prepare("INSERT INTO schema_meta (v, name, applied_at) VALUES (?, ?, ?)").bind(m.v, m.name, Date.now()));
    // One batch = one round-trip = the schema exists atomically or not at all.
    await E.db.batch(statements);
    E.log?.info("schema.applied", { v: m.v, name: m.name, statements: statements.length });
  }
  provisioned = true;
  return { applied: todo.map((m) => m.v), skipped: false };
}

/** Test hook — the latch lives for the lifetime of the isolate. */
export function resetSchemaLatch() {
  provisioned = false;
}
