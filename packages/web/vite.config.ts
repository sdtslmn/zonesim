import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

// Publish the site schema and template next to the app, so the $schema line in
// site files resolves and the template can be linked to directly.
const publishSiteFiles = (): Plugin => ({
  name: "zonesim-site-files",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "schema/site.schema.json", source: readFileSync(root("schema/site.schema.json"), "utf8") });
    this.emitFile({ type: "asset", fileName: "sites/my-site.yaml", source: readFileSync(root("sites/templates/my-site.yaml"), "utf8") });
    this.emitFile({ type: "asset", fileName: "sites/riverside-water.yaml", source: readFileSync(root("sites/riverside-water.yaml"), "utf8") });
  },
});

export default defineConfig({
  // Relative base so the build works on GitHub Pages under /<repo>/.
  base: "./",
  plugins: [publishSiteFiles()],
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
