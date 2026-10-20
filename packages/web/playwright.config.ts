import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const vite = "node ./node_modules/vite/bin/vite.js";

/**
 * The suite runs against a VITE_MOCK=1 production build served by `vite preview` on 5173, so no
 * hub is involved (R3.8). No pnpm needed: the command calls the local vite binary.
 * Headless one-liner (Playwright image, see U4 report):
 *   SCREENS_DIR=<dir> CI=1 node node_modules/@playwright/test/cli.js test
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  outputDir: join(tmpdir(), "sd-pw-results"),
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: [["list"], ["./e2e/summary-reporter.ts"]],
  use: {
    baseURL: "http://localhost:5173",
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    colorScheme: "dark",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: `VITE_MOCK=1 ${vite} build --outDir dist/e2e-mock --emptyOutDir && ${vite} preview --outDir dist/e2e-mock --port 5173 --strictPort --host 127.0.0.1`,
    url: "http://localhost:5173",
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
    stdout: "pipe",
  },
});
