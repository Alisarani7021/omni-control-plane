/**
 * Node test loader: resolve `*.sql` imports the same way wrangler's
 * `[[rules]] type = "Text"` does, so src/db/migrate.js can import the migration
 * files directly and there is exactly ONE copy of the schema in the repo.
 */
import { readFile } from "node:fs/promises";

export async function load(url, context, nextLoad) {
  if (url.endsWith(".sql")) {
    const source = await readFile(new URL(url), "utf8");
    return { format: "module", source: `export default ${JSON.stringify(source)};`, shortCircuit: true };
  }
  return nextLoad(url, context);
}
