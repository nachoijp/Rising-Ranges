import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";
import react from "@vitejs/plugin-react";

// The dev server's extension is "Rising Ranges (3D)", version "…-3d" (this
// branch: the new terrain editor and its Vistazo, tried locally), so it can't
// be mistaken in Owlbear for the released one, the beta (see
// scripts/beta-manifest.mjs) or the dev branch's "(dev)".
function devManifest() {
  return {
    name: "dev-manifest",
    configureServer(server) {
      server.middlewares.use("/manifest.json", (_req, res) => {
        const manifest = JSON.parse(readFileSync(resolve(__dirname, "public/manifest.json"), "utf8"));
        manifest.name = `${manifest.name} (3D)`;
        manifest.version = `${manifest.version}-3d`;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(manifest, null, 2));
      });
    },
  };
}

// The stopwatch's tables (src/timing.ts, while it's on), kept in
// dev-tests/tmp/timing.log too: the extension's frames' consoles are
// awkward to reach in Owlbear.
function devTiming() {
  return {
    name: "dev-timing",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__timing", (req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          mkdirSync(resolve(__dirname, "dev-tests/tmp"), { recursive: true });
          appendFileSync(resolve(__dirname, "dev-tests/tmp/timing.log"), `${new Date().toISOString()}
${body}

`);
          res.end("ok");
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [glsl(), react(), devManifest(), devTiming()],
  // Every page's SDK through src/obr.ts: as it is, but in the Vistazo's own tab a stand-in (see there).
  resolve: {
    alias: [{ find: /^@owlbear-rodeo\/sdk$/, replacement: resolve(__dirname, "src/obr.ts") }],
  },
  build: {
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "background.html"),
        theme: resolve(__dirname, "theme.html"),
        settings: resolve(__dirname, "settings.html"),
        tokenHeight: resolve(__dirname, "token-height.html"),
        distances: resolve(__dirname, "distances.html"),
        terrainVisibility: resolve(__dirname, "terrain-visibility.html"),
        vistazo: resolve(__dirname, "vistazo.html"),
        vistazoTab: resolve(__dirname, "vistazo-tab.html"),
      },
    },
  },
  server: {
    cors: {
      origin: "https://www.owlbear.rodeo",
    },
  },
});
