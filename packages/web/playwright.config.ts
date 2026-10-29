import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const vite = "node ./node_modules/vite/bin/vite.js";

/**
 * Live mode (R3.1, R3.3, R3.6, R3.9, R5.3-live, R5.4-live, R5.5-live; SD_E2E_SKIP_PERF=1 skips R3.6): set SD_E2E_HUB_URL to run only the live specs against a real hub, with a
 * non-mock build on port 5174. Variables (all read by e2e/live-helpers.ts):
 *   SD_E2E_HUB_URL         hub base URL the browser uses (http://host:8787); required
 *   SD_E2E_HUB_TOKEN       the hub's HUB_TOKEN (passed in the environment, never committed)
 *   SD_E2E_HUB_DIRECT_URL  where the test POSTs /ingest; defaults to SD_E2E_HUB_URL
 *   SD_E2E_GATE_URL        ws-gate control URL (scripts/ws-gate.mjs); R3.9 skips without it
 *   SD_E2E_RESTART_DIR   shared dir for hub restart requests (restart.req / restart.ack); the host-side poller in scripts/e2e-live.sh restarts the hub. R5.5-live skips without it. No Docker socket is mounted
 * Unset, the live specs are not run and the mock suite is unchanged. One command that starts the
 * hub, gate and Playwright containers and cleans up: scripts/e2e-live.sh.
 */
const live = (process.env["SD_E2E_HUB_URL"] ?? "") !== "";
const LIVE_SPECS = [
  "**/R3.1.spec.ts",
  "**/R3.3.spec.ts",
  "**/R3.6.spec.ts",
  "**/R3.9.spec.ts",
  "**/R5.5-live.spec.ts",
  "**/R5.4-live.spec.ts",
  "**/R5.3-live.spec.ts",
];
const port = live ? 5174 : 5173;

/**
 * The suite runs against a VITE_MOCK=1 production build served by `vite preview` on 5173, so no
 * hub is involved (R3.8). No pnpm needed: the command calls the local vite binary.
 * Headless one-liner (Playwright image, see U4 report):
 *   SCREENS_DIR=<dir> CI=1 node node_modules/@playwright/test/cli.js test
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: live ? LIVE_SPECS : "**/*.spec.ts",
  testIgnore: live ? [] : LIVE_SPECS,
  // One platform only (the pinned Linux image), so baselines have no platform suffix.
  // Regenerate all of them with: node node_modules/@playwright/test/cli.js test --update-snapshots
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  outputDir: join(tmpdir(), "sd-pw-results"),
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: [["list"], ["./e2e/summary-reporter.ts"]],
  expect: { toHaveScreenshot: { animations: "disabled", caret: "hide" } },
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    colorScheme: "dark",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: live
      ? `${vite} build --outDir dist/e2e-live --emptyOutDir && ${vite} preview --outDir dist/e2e-live --port ${port} --strictPort --host 127.0.0.1`
      : `VITE_MOCK=1 ${vite} build --outDir dist/e2e-mock --emptyOutDir && ${vite} preview --outDir dist/e2e-mock --port ${port} --strictPort --host 127.0.0.1`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
    stdout: "pipe",
  },
});
