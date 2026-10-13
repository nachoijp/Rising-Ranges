import { readFileSync } from "fs";
import { resolve } from "path";
import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";
import react from "@vitejs/plugin-react";

// The dev server's extension is "Rising Ranges (dev)", version "…-dev", so
// it can't be mistaken in Owlbear for the released one or the beta (see
// scripts/beta-manifest.mjs).
function devManifest() {
  return {
    name: "dev-manifest",
    configureServer(server) {
      server.middlewares.use("/manifest.json", (_req, res) => {
        const manifest = JSON.parse(readFileSync(resolve(__dirname, "public/manifest.json"), "utf8"));
        manifest.name = `${manifest.name} (dev)`;
        manifest.version = `${manifest.version}-dev`;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(manifest, null, 2));
      });
    },
  };
}

export default defineConfig({
  plugins: [glsl(), react(), devManifest()],
  build: {
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "background.html"),
        theme: resolve(__dirname, "theme.html"),
        settings: resolve(__dirname, "settings.html"),
        tokenHeight: resolve(__dirname, "token-height.html"),
        distances: resolve(__dirname, "distances.html"),
      },
    },
  },
  server: {
    cors: {
      origin: "https://www.owlbear.rodeo",
    },
  },
});
