import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// The agent core lives in ../core and is bundled from TypeScript source via
// the @core alias (Vite resolves core's NodeNext ".js" imports to .ts files).
// npm dependencies (e.g. the MCP SDK) are externalized and loaded from
// node_modules at runtime; electron-builder packages production deps.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { "@core": resolve(__dirname, "../core/src/index.ts") },
    },
    build: {
      rollupOptions: { input: resolve(__dirname, "src/main/index.ts") },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(__dirname, "src/preload/index.ts") },
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") },
    },
  },
});
