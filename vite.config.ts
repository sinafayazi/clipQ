import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = "http://127.0.0.1:3000";

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
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
