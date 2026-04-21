import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { basename } from "path";

// Library build config for the mountable OpenCode app bundle.
// Build with: bunx vite build --config vite.mount.config.ts

export default defineConfig({
  base: "/opencode-ui/",
  plugins: [
    {
      name: "opencode-mount:config",
      config() {
        return {
          resolve: {
            alias: {
              "@": fileURLToPath(new URL("./src", import.meta.url)),
            },
          },
          worker: {
            format: "es",
          },
        };
      },
    },
    {
      name: "emit-font-assets",
      enforce: "pre",
      load(id) {
        if (!id.endsWith(".woff2")) return null;
        const ref = this.emitFile({
          type: "asset",
          name: basename(id),
          source: readFileSync(id),
        });
        return `export default import.meta.ROLLUP_FILE_URL_${ref}`;
      },
    },
    tailwindcss(),
    solidPlugin(),
  ],
  build: {
    target: "esnext",
    outDir: "dist-mount",
    lib: {
      entry: fileURLToPath(new URL("./src/mount.tsx", import.meta.url)),
      formats: ["es"],
      fileName: "opencode-mount",
    },
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames(info) {
          if (info.names?.some((n) => n.endsWith(".css"))) return "[name][extname]";
          return "assets/[name]-[hash][extname]";
        },
      },
    },
  },
});
