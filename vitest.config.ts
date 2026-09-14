import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The vendored panel tree ships its own suite (run it with
    // `npm --prefix omni-panel test`); this repo's suite lives in tests/.
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./tests/stubs/cloudflare-workers.ts", import.meta.url)),
    },
  },
});
