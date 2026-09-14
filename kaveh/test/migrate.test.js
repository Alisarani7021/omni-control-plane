import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { splitStatements, MIGRATIONS } from "../src/db/migrate.js";

/*
 * The boot-time migration path is what makes a one-tap deploy work, so it gets
 * tested directly against the real SQL file — not a fixture. If someone edits
 * schema/0001_init.sql in a way the splitter cannot handle (a trigger body, a
 * semicolon inside a string literal), these tests fail before production does.
 */

const SCHEMA = readFileSync(new URL("../schema/0001_init.sql", import.meta.url), "utf8");

test("the bundled migration list matches the SQL files on disk", () => {
  assert.equal(MIGRATIONS.length >= 1, true);
  assert.equal(MIGRATIONS[0].name, "0001_init");
  assert.equal(MIGRATIONS[0].sql.trim(), SCHEMA.trim(), "the worker must embed the same SQL wrangler applies");
});

test("splitStatements yields only complete, non-empty DDL", () => {
  const stmts = splitStatements(SCHEMA);
  assert.ok(stmts.length >= 8, `expected the full schema, got ${stmts.length} statements`);
  for (const s of stmts) {
    assert.match(s, /^(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|CREATE TRIGGER|CREATE VIEW|ALTER TABLE|INSERT|PRAGMA)/i, `not DDL: ${s.slice(0, 60)}`);
    assert.equal(s.includes(";"), false, "a stray semicolon means the split was wrong");
    assert.equal(/^\s*--/.test(s), false, "comments must be stripped, not shipped to D1");
  }
});

test("comment lines never become statements", () => {
  const stmts = splitStatements(`-- a comment\n-- another\nCREATE TABLE IF NOT EXISTS t (a INT);\n\n-- trailing\n`);
  assert.deepEqual(stmts, ["CREATE TABLE IF NOT EXISTS t (a INT)"]);
});

test("every table the app queries is created by migration 0001", () => {
  const stmts = splitStatements(SCHEMA).join("\n");
  // If one of these goes missing, the panel boots and then 500s on first click.
  for (const table of ["users", "settings", "sessions", "audit_log", "usage_daily", "plans", "nodes"]) {
    assert.ok(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`).test(stmts), `missing table: ${table}`);
  }
});

test("statements are idempotent — re-running them cannot fail", () => {
  const stmts = splitStatements(SCHEMA);
  for (const s of stmts) {
    if (/^CREATE/.test(s)) assert.match(s, /IF NOT EXISTS/, `not idempotent: ${s.slice(0, 60)}`);
  }
});

/* ── ensureSchema against a recording D1 double ───────────────────────────── */

function recordingD1() {
  const applied = [];
  let meta = [];
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    async run() {
      applied.push(sql);
      if (/^INSERT INTO schema_meta/.test(sql)) meta.push({ v: params[0] });
      return { success: true };
    },
    async all() {
      if (/^SELECT v FROM schema_meta$/.test(sql)) return { results: meta };
      throw new Error("unexpected: " + sql);
    },
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (statements) => { for (const s of statements) await s.run(); return []; },
    _applied: applied,
    _meta: meta,
  };
}

test("ensureSchema applies the migration once and records it", async () => {
  const { ensureSchema, resetSchemaLatch } = await import("../src/db/migrate.js");
  resetSchemaLatch();
  const db = recordingD1();
  const E = { db, log: { info() {}, warn() {}, error() {} } };

  const first = await ensureSchema(E);
  assert.deepEqual(first.applied, [1]);
  assert.deepEqual(db._meta, [{ v: 1 }], "schema_meta must record the version");
  assert.ok(db._applied.some((s) => /CREATE TABLE IF NOT EXISTS users/.test(s)), "users table applied");
});

test("a database that already has the version marker is left alone", async () => {
  const { ensureSchema, resetSchemaLatch } = await import("../src/db/migrate.js");
  resetSchemaLatch();
  const db = recordingD1();
  db._meta.push({ v: 1 }); // pretend migration 0001 already ran
  const E = { db, log: { info() {}, warn() {}, error() {} } };

  const res = await ensureSchema(E);
  assert.deepEqual(res.applied, [], "nothing to do");
  assert.equal(db._applied.some((s) => /CREATE TABLE IF NOT EXISTS users/.test(s)), false, "must not re-apply");
});

test("the latch means one probe per isolate, not per request", async () => {
  const { ensureSchema, resetSchemaLatch } = await import("../src/db/migrate.js");
  resetSchemaLatch();
  const db = recordingD1();
  db._meta.push({ v: 1 });
  const E = { db, log: { info() {}, warn() {}, error() {} } };

  await ensureSchema(E);
  const callsAfterFirst = db._applied.length;
  for (let i = 0; i < 25; i++) await ensureSchema(E);
  assert.equal(db._applied.length, callsAfterFirst, "25 more requests must hit zero extra D1 calls");
});
