import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Dev only: same-origin /stream and REST reach a local hub (leave Settings hubUrl empty).
  server: {
    port: 5173,
    // Loopback by default (the proxy exposes the hub); SD_WEB_HOST=0.0.0.0 for containers.
    host: process.env["SD_WEB_HOST"] ?? "127.0.0.1",
    proxy: {
      "/stream": { target: "http://localhost:8787", ws: true },
      "/sessions": "http://localhost:8787",
      "/health": "http://localhost:8787",
    },
  },
  test: {
    environment: "jsdom",
    pool: "threads",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
  },
});
