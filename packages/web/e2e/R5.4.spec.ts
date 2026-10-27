import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { axeViolations, expectAllReadable, measureAllText } from "./a11y-helpers";
import { freezeClock, setTheme, shot, waitForCards, waitForReplayDone } from "./helpers";

// R5.4: command palette and session list, keyboard only. This file never calls a mouse API: input is
// page.keyboard, locator.press and page.goto. Mock build (VITE_MOCK=1), search served in memory.

/**
 * The settled mock board, with the real clock: Playwright's frozen clock (page.clock.setFixedTime)
 * also empties the User Timing entries the latency measure below reads.
 */
async function openSettledBoard(page: Page): Promise<void> {
  await page.goto("/board?replay=fast");
  await waitForReplayDone(page);
  await waitForCards(page, 8);
}

const filters = (page: Page) => page.getByTestId("session-filters");
const palette = (page: Page) => page.getByTestId("command-palette");
const optionsOf = (page: Page) => palette(page).getByRole("option");

async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press("Control+k");
  await expect(palette(page)).toBeVisible();
  await expect(palette(page).getByRole("combobox")).toBeFocused();
}

/** Types a query and waits until the results shown answer exactly that query. */
async function search(page: Page, q: string): Promise<void> {
  await page.keyboard.type(q);
  await expect(palette(page)).toHaveAttribute("data-results-for", q);
  await expect(palette(page)).toHaveAttribute("data-status", "ready");
}

/** The last in-browser measure: request dispatch to results committed (excludes the debounce). */
async function lastRoundTrip(page: Page, q: string) {
  // The measure is recorded in a passive effect, a tick after the DOM shows the results.
  await expect
    .poll(() =>
      page.evaluate(
        (query) =>
          performance
            .getEntriesByName("sd-palette-search")
            .some((m) => (m as PerformanceMeasure).detail?.q === query),
        q,
      ),
    )
    .toBe(true);
  return page.evaluate((query) => {
    const hits = performance
      .getEntriesByName("sd-palette-search")
      .filter((m) => (m as PerformanceMeasure).detail?.q === query);
    const m = hits[hits.length - 1] as PerformanceMeasure | undefined;
    return m
      ? { ms: m.duration, tookMs: m.detail.tookMs as number, n: m.detail.results as number }
      : null;
  }, q);
}

const latencies: Record<string, unknown>[] = [];

test.afterAll(() => {
  writeFileSync(shot("R5.4-latency.json"), JSON.stringify(latencies, null, 2));
});

test("R5.4 palette: Ctrl+K, type, ArrowDown, Enter jumps to a project", async ({ page }) => {
  await openSettledBoard(page);
  await page.keyboard.press("j"); // a card is focused: Ctrl+K must work from a non-text control
  await openPalette(page);
  // Empty query: recent items, no typing needed.
  await expect(palette(page)).toHaveAttribute("data-results-for", "");
  expect(await optionsOf(page).count()).toBeGreaterThan(0);

  await search(page, "harvest");
  const groups = palette(page).getByRole("group");
  await expect(groups.nth(0)).toContainText("Sessions");
  await expect(groups.nth(1)).toContainText("Projects");
  const rt = await lastRoundTrip(page, "harvest");
  expect(rt).not.toBeNull();
  latencies.push({
    flow: "mock palette: harvest",
    roundTripMs: rt!.ms,
    hubTookMs: rt!.tookMs,
    results: rt!.n,
  });
  expect(rt!.ms).toBeLessThan(100);

  await expect(optionsOf(page).first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  const active = await palette(page).getByRole("combobox").getAttribute("aria-activedescendant");
  const option = palette(page).locator(`[id="${active}"]`);
  await expect(option).toHaveAttribute("data-kind", "project");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/projects\/p_[0-9a-f]{32}$/);
  await expect(page.getByTestId("project-name")).toContainText("harvest");
});

test("R5.4 palette: Enter on a session opens its drawer; Escape restores focus", async ({
  page,
}) => {
  await openSettledBoard(page);
  await page.keyboard.press("j");
  const focusedId = await page.evaluate(() =>
    document.activeElement?.getAttribute("data-session-id"),
  );
  await openPalette(page);
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-session-id"))).toBe(
    focusedId,
  );

  await openPalette(page);
  await search(page, "scheduler");
  await expect(optionsOf(page).first()).toHaveAttribute("data-kind", "session");
  await page.keyboard.press("Enter");
  const drawer = page.getByTestId("detail-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("Harvest scheduler retries");
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
});

test("R5.4 palette: results are grouped Sessions, Projects, Phases", async ({ page }) => {
  await openSettledBoard(page);
  await openPalette(page);
  await expect(palette(page)).toHaveAttribute("data-status", "ready");
  await page.screenshot({ path: shot("R5.4-palette.png") });
  await search(page, "atlas");
  const groups = palette(page).getByRole("group");
  await expect(groups).toHaveCount(3);
  await expect(groups.nth(0)).toContainText("Sessions");
  await expect(groups.nth(1)).toContainText("Projects");
  await expect(groups.nth(2)).toContainText("Phases");
  await expect(optionsOf(page).first()).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: shot("R5.4-results.png") });
});

for (const theme of ["dark", "light"] as const) {
  test(`R5.4 palette: jump to a phase, then j/k/Enter/Escape on /sessions (${theme})`, async ({
    page,
  }) => {
    await setTheme(page, theme);
    await openSettledBoard(page);
    await openPalette(page);
    await search(page, "p3");
    const rt = await lastRoundTrip(page, "p3");
    latencies.push({
      flow: `mock palette: p3 (${theme})`,
      roundTripMs: rt?.ms,
      hubTookMs: rt?.tookMs,
    });
    expect(rt!.ms).toBeLessThan(100);
    expect(await optionsOf(page).count()).toBeGreaterThan(1);
    expect(await axeViolations(page, `${theme} palette`)).toEqual([]);
    expectAllReadable(await measureAllText(page), `${theme} palette`);

    await page.keyboard.press("ArrowUp"); // wraps to the last option: the phase
    const active = await palette(page).getByRole("combobox").getAttribute("aria-activedescendant");
    await expect(palette(page).locator(`[id="${active}"]`)).toHaveAttribute("data-kind", "phase");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/sessions\?project=p_[0-9a-f]{32}&phase=P3$/);
    const rows = page.getByTestId("session-list-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Board mock and drawer");
    await expect(filters(page).getByLabel("Phase")).toHaveValue("P3");

    // List keys: j selects (and focuses), Enter opens the drawer, Escape closes it, Escape clears.
    await page.keyboard.press("j");
    await expect(rows.first()).toHaveAttribute("data-selected", "true");
    await expect(rows.first()).toBeFocused();
    await page.keyboard.press("Enter");
    const drawer = page.getByTestId("detail-drawer");
    await expect(drawer).toContainText("Board mock and drawer");
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(rows.first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(rows.first()).toHaveAttribute("data-selected", "false");
  });
}

test("R5.4 session list: filters in the URL, sort, j/k, / and the screenshot", async ({ page }) => {
  await freezeClock(page);
  await page.goto("/sessions?replay=fast");
  await waitForReplayDone(page);
  const rows = page.getByTestId("session-list-row");
  await expect(rows).toHaveCount(33);
  await expect(page.getByTestId("sessions-count")).toHaveText("33 of 33 sessions");
  // Default sort: last activity, newest first.
  const activity = await rows.locator('[data-slot="activity"]').allTextContents();
  expect(activity.length).toBe(33);

  // Filters by keyboard: focus the select, type the option label, the URL follows.
  await page.keyboard.press("/");
  await expect(page.getByLabel(/Filter sessions by text/)).toBeFocused();
  await page.keyboard.press("Escape");
  await filters(page).getByLabel("Host").press("ArrowDown");
  await expect(page).toHaveURL(/host=stack-/);
  const host = new URL(page.url()).searchParams.get("host")!;
  await filters(page).getByLabel("Date").press("ArrowDown"); // Today
  await filters(page).getByLabel("Date").press("ArrowDown"); // Last 7 days
  await expect(page).toHaveURL(/range=7d/);
  await filters(page).getByLabel("Sort").press("ArrowDown"); // Started
  await expect(page).toHaveURL(/sort=started/);
  const n = await rows.count();
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThan(33);
  await expect(page.getByTestId("sessions-count")).toHaveText(`${n} of 33 sessions`);
  for (const h of await rows.locator('[data-slot="started"]').all())
    await expect(h).not.toHaveText("n/a");

  // Reload: the view is linkable.
  await page.goto(`/sessions?replay=fast&host=${host}&range=7d&sort=started`);
  await waitForReplayDone(page);
  await expect(rows).toHaveCount(n);
  await expect(filters(page).getByLabel("Host")).toHaveValue(host);

  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(rows.nth(1)).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("k");
  await expect(rows.first()).toHaveAttribute("data-selected", "true");
  await page.screenshot({ path: shot("R5.4-sessions.png") });
  expect(await axeViolations(page, "sessions list")).toEqual([]);
  expectAllReadable(await measureAllText(page), "sessions list");
});

test("R5.4 board keys still work, and are not triggered by typing in the palette", async ({
  page,
}) => {
  await openSettledBoard(page);
  await page.keyboard.press("c"); // compact still works on the board
  await expect(page.getByRole("button", { name: /Compact: on/ })).toBeVisible();
  await openPalette(page);
  await page.keyboard.type("c");
  await expect(palette(page).getByRole("combobox")).toHaveValue("c"); // typed into the palette, not a shortcut
  await page.keyboard.press("Escape");
});
