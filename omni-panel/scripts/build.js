#!/usr/bin/env node
/**
 * `npm run build` — asset budget report.
 *
 * There is no bundler and nothing to compile; what this guards is *size*.
 * Zeus ships ~630 KB of Worker source, of which the panel HTML/CSS/JS alone is
 * over 200 KB re-generated on every request. Kaveh's budget is explicit, and
 * CI fails the build if a change pushes the first-load payload past it.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const UI = join(ROOT, "ui");
// The gate that matters to a user on a 3G line in Tehran is firstLoadGzip
// (what actually blocks first paint). totalUi is a raw-byte anti-bloat rail:
// it includes the 56 KB vendored QR encoder and, since design-system v2, the
// fx/nettest modules. 240 KB raw across 15 files is still ~2.6× smaller than
// Zeus's single 634 KB worker, and none of it loads from a CDN.
const BUDGET = { firstLoadGzip: 60_000, totalUi: 240_000, workerSource: 150_000 };

const FIRST_LOAD = ["index.html", "assets/app.css", "assets/app.js", "assets/api.js", "assets/i18n.js", "assets/charts.js", "assets/components.js", "assets/views.js", "assets/fx.js", "assets/nettest.js"];

const gz = async (rel) => gzipSync(await readFile(join(UI, rel))).length;
const raw = async (rel) => (await stat(join(UI, rel))).size;

async function total(dir) {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? await total(join(dir, e.name)) : (await stat(join(dir, e.name))).size;
  }
  return n;
}
async function srcTotal(dir) {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    n += e.isDirectory() ? await srcTotal(p) : /\.js$/.test(e.name) ? (await stat(p)).size : 0;
  }
  return n;
}

const rows = [];
let first = 0;
for (const f of FIRST_LOAD) {
  const g = await gz(f);
  first += g;
  rows.push([f, await raw(f), g]);
}
const vendorGz = await gz("assets/vendor/qrcode.js");

console.log("\n  first-load payload (gzipped)");
for (const [f, r, g] of rows) console.log(`    ${f.padEnd(28)} ${String(r).padStart(7)} B  → ${String(g).padStart(6)} B`);
console.log(`    ${"vendor/qrcode.js (deferred)".padEnd(28)} ${String(await raw("assets/vendor/qrcode.js")).padStart(7)} B  → ${String(vendorGz).padStart(6)} B`);
console.log(`    ${"TOTAL (blocking)".padEnd(28)} ${"".padStart(7)}    ${String(first).padStart(6)} B   budget ${BUDGET.firstLoadGzip} B`);

const ui = await total(UI);
const worker = await srcTotal(join(ROOT, "src"));
console.log(`\n  reference: Zeus ships one 634,000 B Worker file (~11,000 lines)`);
console.log(`  ui/ total      ${String(ui).padStart(8)} B   budget ${BUDGET.totalUi} B`);
console.log(`  src/ worker    ${String(worker).padStart(8)} B   budget ${BUDGET.workerSource} B\n`);

let bad = 0;
if (first > BUDGET.firstLoadGzip) { console.error(`✗ first-load over budget by ${first - BUDGET.firstLoadGzip} B`); bad++; }
if (ui > BUDGET.totalUi) { console.error(`✗ ui/ over budget`); bad++; }
if (worker > BUDGET.workerSource) { console.error(`✗ worker source over budget`); bad++; }
if (bad) process.exit(1);
console.log("  ✓ within budget");
