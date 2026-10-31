import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const api = "http://127.0.0.1:3000";

/** Dev only: /s/<channel> is one page for every channel, like the server does in production. */
const songPageRoute: Plugin = {
  name: "song-page-route",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url && /^\/s\/[^/?]+\/?(\?|$)/.test(req.url)) req.url = "/s/index.html" + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "");
      next();
    });
  },
};

export default defineConfig({
  root: "src/web",
  plugins: [react(), songPageRoute],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    // Landing pages are static HTML (readable by search engines); the dashboard is the React app.
    rollupOptions: {
      input: {
        landing: resolve(here, "src/web/index.html"),
        landingFa: resolve(here, "src/web/fa/index.html"),
        app: resolve(here, "src/web/app/index.html"),
        songs: resolve(here, "src/web/s/index.html"),
        obs: resolve(here, "src/web/obs/index.html"),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      // Trailing slashes matter: "/api" would also catch the web module "/api.ts".
      "/api/": api,
      "/auth/": api,
      "/ws": { target: api, ws: true },
    },
  },
});
