import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Test against workspace sources, not built output.
    alias: {
      "@gesso/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@gesso/psd": fileURLToPath(new URL("./packages/psd/src/index.ts", import.meta.url)),
      "@gesso/render": fileURLToPath(new URL("./packages/render/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
