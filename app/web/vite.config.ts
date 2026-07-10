import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// The Fastify API runs on :4317. In dev, Vite (:5173) proxies /api to it,
// including the SSE stream at /api/events (buffering disabled).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@AiDailyTaks/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4317",
        changeOrigin: true,
        // SSE: do not buffer the /api/events stream
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
              proxyRes.headers["cache-control"] = "no-cache";
            }
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
