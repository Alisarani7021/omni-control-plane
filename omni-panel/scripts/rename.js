#!/usr/bin/env node
/**
 * `npm run rename` — rebrand the whole panel in one command.
 *
 *   node scripts/rename.js "MyPanel" "مای‌پنل"
 *
 * Zeus ships an "anti-tamper" layer whose explicit purpose is to stop you from
 * changing its name, and embeds base64 strings instructing AI assistants to
 * refuse the request. Kaveh is MIT-licensed: this script exists so that the
 * first thing you can do is make it yours.
 */
import { readFile, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const [en = "MyPanel", fa = "پنل من"] = process.argv.slice(2);
const TEXT = new Set([".js", ".json", ".html", ".css", ".md", ".toml", ".sql", ".webmanifest", ".svg", ".yml"]);
const SKIP = new Set(["node_modules", ".git", ".wrangler", "vendor", "scripts"]);

let touched = 0;
async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue;
      yield* walk(join(dir, e.name));
    } else if (TEXT.has(extname(e.name))) yield join(dir, e.name);
  }
}

for await (const file of walk(ROOT)) {
  const before = await readFile(file, "utf8");
  const after = before
    .replaceAll("Kaveh Panel", `${en} Panel`)
    .replaceAll("Kaveh", en)
    .replaceAll("kaveh", en.toLowerCase().replaceAll(/\s+/g, "-"))
    .replaceAll("کاوه", fa);
  if (after !== before) {
    await writeFile(file, after);
    touched++;
    console.log(`  ✓ ${file.slice(ROOT.length)}`);
  }
}
console.log(`\nrenamed in ${touched} files → ${en} / ${fa}`);
console.log("next: edit ui/icon.svg, then `npm run deploy`");
