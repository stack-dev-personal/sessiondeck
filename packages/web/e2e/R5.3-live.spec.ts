import { expect, test, type Page } from "@playwright/test";
import { shot } from "./helpers";
import {
  LIVE,
  archiveEnvelope,
  configureHub,
  endEnv,
  hookEnvelope,
  hubJson,
  ingest,
  newSessionId,
  waitConnected,
} from "./live-helpers";

test.skip(LIVE.hubUrl === "", "live spec: set SD_E2E_HUB_URL (see playwright.config.ts)");

/**
 * R5.3 (user-visible side) and R5.6 "last 20 archived" against a real hub. A live session is
 * ingested through hook envelopes, then an archive envelope for the same (host, session_id) is
 * posted: the session list and the project view must show ONE record carrying the archive fields.
 * A second session exists only as an archive entry. Outcome words are found through Ctrl+K.
 */
const RLO = String.fromCodePoint(0x202e);
const palette = (page: Page) => page.getByTestId("command-palette");

test("R5.3 live: merged and archived-only records, search opens the archived session", async ({
  page,
}) => {
  const r = Math.random().toString(36).slice(2, 8);
  const cwd = `/home/e2e/atlas${r}`;
  const heron = `heron${r}`;
  const ibis = `ibis${r}`;
  const merged = newSessionId();
  const only = newSessionId();

  await ingest([
    hookEnvelope(merged, "SessionStart", "SessionStart/01-startup.json", { cwd }),
    hookEnvelope(merged, "UserPromptSubmit", "UserPromptSubmit/01-sample.json", {
      cwd,
      prompt: "Scaffold the web shell",
    }),
    endEnv(merged),
  ]);
  await ingest([
    archiveEnvelope(merged, "projects/sessiondeck/sessions/2026-09-11-1000-web-shell.md.json", {
      title: "Web shell scaffold",
      outcome: `The ${heron} nav shell boots and the first screen renders.`,
      project_dir: cwd,
      branch: "p3/shell",
    }),
    archiveEnvelope(only, "projects/sessiondeck/sessions/2026-09-11-1500-hub-auth.md.json", {
      title: `Hub auth${RLO} only`,
      outcome: `Token check lands; ${ibis} rejects a bad bearer.`,
      project_dir: cwd,
      branch: "p3/auth",
    }),
  ]);

  // The REST shape the UI relies on: one record for the merged session, archive attached.
  const row = await hubJson<{ state: string; last_prompt?: string; archive?: { outcome: string } }>(
    `/sessions/${merged}`,
  );
  expect(row.state).toBe("ended");
  expect(row.last_prompt).toBe("Scaffold the web shell");
  expect(row.archive?.outcome).toContain(heron);
  const project = (await hubJson<{ project_id: string }>(`/sessions/${merged}`)).project_id;
  const onlyRow = await hubJson<{ project_id: string; archive?: unknown }>(`/sessions/${only}`);
  expect(onlyRow.project_id).toBe(project);
  expect(onlyRow.archive).toBeDefined();

  await configureHub(page);
  await page.goto(`/projects/${project}`);
  await waitConnected(page);
  const archived = page.getByTestId("archived-list");
  const mergedRow = archived.locator(`[data-session-id="${merged}"]`);
  await expect(mergedRow).toBeVisible({ timeout: 10_000 });
  // One record: the session is in the archived list once and not in the live list.
  await expect(
    page.locator(`[data-testid="project-session"][data-session-id="${merged}"]`),
  ).toHaveCount(1);
  await expect(mergedRow.locator('[data-slot="archived-badge"]').first()).toContainText("Archived");
  await expect(mergedRow.locator('[data-slot="outcome"]')).toContainText(heron);
  await expect(mergedRow.locator('[data-slot="duration"]')).toHaveText("40m");
  await expect(mergedRow.locator('[data-slot="commits"]')).toHaveText("1 commit");
  await expect(mergedRow.locator('[data-slot="prs"]')).toHaveText("1 PR");
  await expect(mergedRow).toContainText("Web shell scaffold");
  // Live fields still there.
  await expect(mergedRow.locator('[data-slot="where"]')).toContainText("p3/shell");
  const onlyProjectRow = archived.locator(`[data-session-id="${only}"]`);
  await expect(onlyProjectRow).toContainText("<U+202E>");
  expect(await onlyProjectRow.textContent()).not.toContain(RLO);
  await expect(onlyProjectRow.locator('[data-slot="outcome"]')).toContainText(ibis);
  await expect(page.getByTestId("live-list").locator(`[data-session-id="${merged}"]`)).toHaveCount(
    0,
  );
  await page.screenshot({ path: shot("R5.3.png") });
  await page.locator('[data-section="archived"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: shot("R5.6-archived.png") });

  // Session list: one row for the merged session, marked archived.
  await page.goto("/sessions");
  await page.getByRole("searchbox").fill(`atlas${r}`);
  const listRows = page.getByTestId("session-list-row");
  await expect(listRows).toHaveCount(2, { timeout: 10_000 });
  const lm = listRows.locator(`xpath=self::*[@data-session-id="${merged}"]`);
  await expect(lm).toHaveCount(1);
  await expect(lm.locator('[data-slot="state"]')).toContainText("Archived");
  await expect(lm.locator('[data-slot="outcome"]')).toContainText(heron);
  await expect(lm.locator('[data-slot="branch"]')).toContainText("p3/shell");
  await page.screenshot({ path: shot("R5.3-session-list.png") });

  // Search: an outcome word finds the archived session and Enter opens it.
  await page.goto("/board");
  await waitConnected(page);
  await page.keyboard.press("Control+k");
  await expect(palette(page).getByRole("combobox")).toBeFocused();
  await page.keyboard.type(heron);
  await expect(palette(page)).toHaveAttribute("data-results-for", heron, { timeout: 10_000 });
  await expect(palette(page)).toHaveAttribute("data-status", "ready");
  const hit = palette(page).getByRole("option").first();
  await expect(hit).toHaveAttribute("data-result-id", merged);
  await expect(hit).toHaveAttribute("data-kind", "session");
  await expect(hit).toContainText(heron);
  await page.screenshot({ path: shot("R5.3-search.png") });
  await page.keyboard.press("Enter");
  const drawer = page.getByTestId("detail-drawer");
  await expect(drawer).toHaveAttribute("data-session-id", merged);
  await expect(drawer.locator('[data-slot="archive-outcome"]')).toContainText(heron);
  await expect(drawer.locator("header h2")).toHaveText("Web shell scaffold");
  await expect(drawer.locator("header").getByText("Archived")).toBeVisible();
  await page.screenshot({ path: shot("R5.3-drawer.png") });
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);

  // The archived-only session is searchable too.
  await page.keyboard.press("Control+k");
  await page.keyboard.type(ibis);
  await expect(palette(page)).toHaveAttribute("data-results-for", ibis, { timeout: 10_000 });
  await expect(palette(page).getByRole("option").first()).toHaveAttribute("data-result-id", only);
  await page.keyboard.press("Enter");
  await expect(drawer).toHaveAttribute("data-session-id", only);
  await expect(drawer.locator('[data-slot="archive-outcome"]')).toContainText(ibis);
});
