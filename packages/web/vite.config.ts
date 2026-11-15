import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // Relative base so the build works on GitHub Pages under /<repo>/.
  base: "./",
  resolve: {
    alias: {
      // Use the core sources directly, no separate build step needed.
      "@zonesim/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
  server: {
    fs: { allow: ["../.."] },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1000,
  },
});
