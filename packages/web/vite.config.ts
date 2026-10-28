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
      // /sessions is also an SPA route (the session list): same rule as /projects.
      "/sessions": {
        target: "http://localhost:8787",
        bypass: (req) => (req.headers.accept?.includes("text/html") ? "/index.html" : undefined),
      },
      // /projects is also an SPA route: browser navigations (Accept: text/html) get the app, fetches go to the hub.
      "/projects": {
        target: "http://localhost:8787",
        bypass: (req) => (req.headers.accept?.includes("text/html") ? "/index.html" : undefined),
      },
      "/health": "http://localhost:8787",
    },
  },
  test: {
    // Must exceed asyncUtilTimeout (5000) in test-setup.ts so real query failures show a DOM dump.
    testTimeout: 10_000,
    pool: "threads",
    setupFiles: ["src/test-setup.ts"],
    projects: [
      {
        // DOM files share a module cache per worker (isolate: false; jsdom is still per file); test-setup.ts resets shared state.
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          isolate: false,
          include: [
            "src/{App,routes,components,mock,alerts}/**/*.test.{ts,tsx}",
            "src/App.test.tsx",
            "src/store/{board,filters}.test.ts",
          ],
        },
      },
      {
        // Only src/{App,routes,components,mock,alerts} and store/{board,filters} get jsdom. A DOM test
        // elsewhere (src/lib, live, styles, root) needs a `// @vitest-environment jsdom` docblock or a dom glob.
        // Pure logic files run under node (`@vitest-environment node` pragma kept as documentation).
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: [
            "src/{App,routes,components,mock,alerts}/**",
            "src/App.test.tsx",
            "src/store/{board,filters}.test.ts",
          ],
        },
      },
    ],
  },
});
