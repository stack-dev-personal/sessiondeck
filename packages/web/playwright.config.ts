import { defineConfig } from "@playwright/test";

// Wired up by U4; the smoke spec in e2e/ is a placeholder until then.
export default defineConfig({
  testDir: "e2e",
  use: { baseURL: "http://localhost:5173" },
  webServer: {
    command: "VITE_MOCK=1 pnpm dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
  },
});
