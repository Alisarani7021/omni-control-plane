import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../wrangler.jsonc", import.meta.url);
let config = readFileSync(path, "utf8");

if (!/"API_TOKEN_TTL_SECONDS"\s*:/u.test(config)) {
  const bootstrap = /("BOOTSTRAP_TTL_SECONDS"\s*:\s*"[^"]+"\s*,?)/u;
  if (!bootstrap.test(config)) throw new Error("BOOTSTRAP_TTL_SECONDS was not found in wrangler.jsonc");
  config = config.replace(bootstrap, (match) => `${match.replace(/,?\s*$/u, ",")}\n    "API_TOKEN_TTL_SECONDS": "7200",`);
}

if (!/"crons"\s*:\s*\[[^\]]*"\*\/5 \* \* \* \*"/su.test(config)) {
  if (/"triggers"\s*:/u.test(config)) {
    throw new Error("wrangler.jsonc already has triggers; add the */5 * * * * cron without replacing existing triggers");
  }
  const observability = /^(\s*)"observability"\s*:/mu;
  if (!observability.test(config)) throw new Error("observability block was not found in wrangler.jsonc");
  config = config.replace(observability, (_match, indent) => `${indent}"triggers": {\n${indent}  "crons": ["*/5 * * * *"]\n${indent}},\n${indent}"observability":`);
}

writeFileSync(path, config);
console.log("wrangler.jsonc now has API_TOKEN_TTL_SECONDS=7200 and a five-minute cleanup cron.");
