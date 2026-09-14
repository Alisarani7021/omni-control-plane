/**
 * Contract test: the mock API in server/dev.js must expose every route the
 * Worker exposes. Without this, the UI silently works in dev and 404s in
 * production — the single most common failure mode of "mock-first" frontends.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ROUTE_RE = /router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
const MOCK_RE = /p === "(\/api\/[^"]+)"|(\/api\/[\w:/()-]+)\.exec|\^\\\/api\\\/([^\n]+?)\$\/\.exec/g;

test("every worker route is implemented by the dev mock", async () => {
  const worker = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const mock = await readFile(new URL("../server/dev.js", import.meta.url), "utf8");

  const routes = [...worker.matchAll(ROUTE_RE)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert.ok(routes.length >= 20, `expected a real route table, found ${routes.length}`);

  // The mock dispatches parametrised routes with a regex plus a switch on the
  // trailing segment, so we require every *static* segment of the path to
  // appear in the mock source rather than the literal path.
  const missing = routes.filter((r) => {
    const segments = r.split(" ")[1].split("/").filter((s) => s && !s.startsWith(":"));
    return !segments.every((seg) => mock.includes(seg));
  });
  assert.deepEqual(missing, [], `dev mock is missing: ${missing.join(", ")}`);
});

test("the mock never leaks the admin password hash", async () => {
  const mock = await readFile(new URL("../server/dev.js", import.meta.url), "utf8");
  assert.match(mock, /delete s\.admin_hash/, "settings must be redacted before reaching the browser");
});
