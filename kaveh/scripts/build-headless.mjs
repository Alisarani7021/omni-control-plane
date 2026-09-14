/**
 * Headless bundle — the tenant-node build.
 *
 * The control plane (v13 Telegram bot) deploys THIS into a tenant's own
 * Cloudflare account: one self-contained Worker file, no [assets], no UI.
 * The panel UI for those nodes lives on the control plane; the node exposes
 * the API + the VLESS tunnel + the agent channel (AGENT_KEY).
 *
 * Pinned & hashed: v13 fetches this artifact by commit and verifies the
 * sha256 before upload — same discipline as its own DATA_PLANE_SOURCE.
 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist-headless");

await mkdir(OUT, { recursive: true });
await build({
  entryPoints: [join(ROOT, "src/index.js")],
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "neutral",
  external: ["cloudflare:sockets"],
  // wrangler's DEFAULT module rules treat .sql/.html/.txt as Text imports
  // (src/db/migrate.js imports the migration files directly); mirror that.
  loader: { ".sql": "text", ".html": "text", ".txt": "text" },
  minify: true,
  legalComments: "none",
  outfile: join(OUT, "kaveh-headless.js"),
});

const src = await readFile(join(OUT, "kaveh-headless.js"));
const sha = createHash("sha256").update(src).digest("hex");
await writeFile(join(OUT, "SHA256"), `${sha}  kaveh-headless.js\n`);
console.log(`dist-headless/kaveh-headless.js  ${src.byteLength} B  sha256 ${sha.slice(0, 16)}…`);
