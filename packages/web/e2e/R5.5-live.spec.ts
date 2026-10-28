import { expect, test } from "@playwright/test";
import { editPhaseWithKeyboard, sessionRow } from "./atlas-helpers";
import { shot } from "./helpers";
import {
  HUB_RESTART_DIR,
  LIVE,
  card,
  configureHub,
  hubJson,
  ingest,
  newSessionId,
  promptEnv,
  restartHub,
  startEnv,
  waitConnected,
} from "./live-helpers";

test.skip(LIVE.hubUrl === "", "live spec: set SD_E2E_HUB_URL (see playwright.config.ts)");
test.skip(
  HUB_RESTART_DIR === "",
  "needs SD_E2E_RESTART_DIR, the host-side restart poller (scripts/e2e-live.sh)",
);

/**
 * R5.5 against a real hub, with real CORS (the app origin is in the hub's HUB_ALLOWED_ORIGINS, no
 * request interception): edit a phase inline with the keyboard, restart the hub process,
 * reload the page, and the manual label is still there (it lives in session_overrides, outside the
 * replayable sessions table).
 */
test("R5.5 a manual phase label survives a hub restart and a page reload", async ({ page }) => {
  const id = newSessionId();
  await ingest([startEnv(id), promptEnv(id)]);

  await configureHub(page);
  await page.goto("/board");
  await waitConnected(page);
  await card(page, id).waitFor({ state: "visible", timeout: 10_000 });

  const before = await hubJson<{ project_id: string; phase: string | null }>(`/sessions/${id}`);
  expect(before.project_id).toMatch(/^p_/);

  await page.goto(`/projects/${before.project_id}`);
  const row = sessionRow(page, id);
  await expect(row).toBeVisible({ timeout: 10_000 });
  const label = `Hardening ${Date.now() % 100000}`;
  await editPhaseWithKeyboard(page, row, label);
  await expect(row.getByTestId("phase-chip")).toContainText(label);
  await expect(row.getByTestId("phase-chip")).toContainText("manual");
  expect((await hubJson<{ phase: string }>(`/sessions/${id}`)).phase).toBe(label);

  await restartHub();
  expect(await hubJson<{ phase: string; phase_source: string }>(`/sessions/${id}`)).toMatchObject({
    phase: label,
    phase_source: "manual",
  });

  await page.reload();
  await waitConnected(page);
  const again = sessionRow(page, id);
  await expect(again).toBeVisible({ timeout: 10_000 });
  await expect(again.getByTestId("phase-chip")).toContainText(label);
  await expect(again.getByTestId("phase-chip")).toContainText("manual");
  await page.screenshot({ path: shot("R5.5-live.png") });

  // Empty restores the inferred value (none here) and that also persists.
  await editPhaseWithKeyboard(page, again, "");
  await expect(again.getByTestId("phase-chip")).toContainText("none");
  expect((await hubJson<{ phase: string | null }>(`/sessions/${id}`)).phase).toBeNull();
});
