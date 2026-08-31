import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Vitest runs the main-process modules outside Electron, so tests can exercise
// the pure seams (e.g. OpenArtClient with a fake McpManager). The @core alias
// mirrors the electron.vite config; Vite resolves the NodeNext ".js" imports
// in core/src and app/src to their .ts sources.
export default defineConfig({
  resolve: {
    alias: { "@core": resolve(__dirname, "../core/src/index.ts") },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup-dom.ts"],
  },
});