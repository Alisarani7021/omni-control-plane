import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function files(root) {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}
const sourceFiles = files(new URL("../src", import.meta.url).pathname).filter((path) => /\.(?:ts|js)$/u.test(path));
const rules = [
  { name: "legacy forgeable cookie", pattern: /omni_auth\s*=\s*1/iu },
  { name: "public setWebhook route", pattern: /pathname\s*===?\s*["']\/setwebhook/iu },
  { name: "hardcoded Telegram token", pattern: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/u },
  { name: "legacy Global API Key header", pattern: /X-Auth-(?:Key|Email)/iu },
  { name: "remote source deployment", pattern: /raw\.githubusercontent\.com|cdn\.jsdelivr\.net/iu, allowedSuffix: "/src/panel-catalog.ts" },
];
let failed = false;
for (const path of sourceFiles) {
  const content = readFileSync(path, "utf8");
  for (const rule of rules) {
    if (rule.pattern.test(content) && (!rule.allowedSuffix || !path.endsWith(rule.allowedSuffix))) {
      console.error(`${rule.name}: ${path}`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log(`Security preflight passed for ${sourceFiles.length} source files.`);
