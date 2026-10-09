import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API serves the built app from the same origin. In development, Vite proxies /api so the session cookie,
// the CSRF header, and the event stream behave exactly as in production.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:8765", changeOrigin: false } },
  },
  build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 900 },
});
