import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = "http://localhost:3000";

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      // Trailing slashes matter: "/api" would also catch the web module "/api.ts".
      "/api/": api,
      "/auth/": api,
      "/ws": { target: api, ws: true },
    },
  },
});
