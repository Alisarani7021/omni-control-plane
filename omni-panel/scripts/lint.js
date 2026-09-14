#!/usr/bin/env node
/**
 * `npm run lint` — no ESLint config to maintain, no plugins to install.
 * Three checks that actually catch real regressions:
 *   1. every JS file parses as ESM
 *   2. no CDN URLs anywhere in the shipped UI (this is a hard product rule:
 *      a panel used from inside Iran must not depend on jsdelivr/unpkg)
 *   3. no secrets committed
 */
import { readFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", ".git", ".wrangler"]);
const CDN = /(cdn\.tailwindcss\.com|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)/;
const SECRET = /(api[_-]?key|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9_\-]{24,}["']/i;

let files = [];
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) await walk(join(dir, e.name));
    } else files.push(join(dir, e.name));
  }
}
await walk(ROOT);

let failures = 0;
const js = files.filter((f) => extname(f) === ".js");
for (const f of js) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  } catch (e) {
    failures++;
    console.error(`✗ parse  ${f.slice(ROOT.length)}\n${e.stderr?.toString().split("\n").slice(0, 4).join("\n")}`);
  }
}

const shipped = files.filter((f) => /\.(js|css|html|webmanifest)$/.test(f) && !f.includes("/vendor/") && !f.includes("/test/") && !f.includes("/scripts/"));
for (const f of shipped) {
  const src = await readFile(f, "utf8");
  if (CDN.test(src)) {
    failures++;
    console.error(`✗ cdn    ${f.slice(ROOT.length)} — third-party CDN reference (must be self-hosted)`);
  }
  const m = SECRET.exec(src);
  if (m && !/mock only|example|PUT-YOUR/.test(m[0])) {
    failures++;
    console.error(`✗ secret ${f.slice(ROOT.length)} — possible hardcoded credential`);
  }
}

const size = files.filter((f) => f.includes("/ui/")).reduce((a, f) => a, 0);
console.log(`${js.length} files parsed · ${shipped.length} shipped assets scanned`);
if (failures) {
  console.error(`\n${failures} problem(s)`);
  process.exit(1);
}
console.log("✓ clean");
