import { cpSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * pdf.js reads character maps (for Chinese and Japanese PDFs) and the standard fonts as files.
 * In development they are served from node_modules; a build copies them to /pdfjs.
 */
function pdfjsFiles(): Plugin {
  let outDir = "dist";
  return {
    name: "cove-pdfjs-files",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    writeBundle() {
      for (const folder of ["cmaps", "standard_fonts"]) {
        cpSync(resolve("node_modules/pdfjs-dist", folder), resolve(outDir, "pdfjs", folder), { recursive: true });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfjsFiles()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "safari13",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
});
