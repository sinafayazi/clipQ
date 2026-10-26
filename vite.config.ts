import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const api = "http://127.0.0.1:3000";

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    // Landing pages are static HTML (readable by search engines); the dashboard is the React app.
    rollupOptions: {
      input: {
        landing: resolve(here, "src/web/index.html"),
        landingFa: resolve(here, "src/web/fa/index.html"),
        app: resolve(here, "src/web/app/index.html"),
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
