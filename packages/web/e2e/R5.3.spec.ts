import { expect, test } from "@playwright/test";
import { axeViolations, expectAllReadable, measureAllText } from "./a11y-helpers";
import { openMockProject } from "./atlas-helpers";
import { fullShot, setTheme } from "./helpers";

// R5.3 (user-visible side) and R5.6 "last 20 archived", mock build: archived records render as one
// marked row with the capture's fields; hostile characters are made visible; the palette finds an
// outcome word and opens that session.

const RLO = String.fromCodePoint(0x202e);

for (const theme of ["dark", "light"] as const) {
  test(`R5.3 ${theme}: archived rows show badge, outcome, duration, commits and PRs`, async ({
    page,
  }) => {
    await setTheme(page, theme);
    await openMockProject(page, "bb2dash");
    const list = page.getByTestId("archived-list");
    const row = list.locator('[data-session-id="mock-archived-01"]');
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-archived", "true");
    await expect(row.locator('[data-slot="archived-badge"]').first()).toContainText("Archived");
    await expect(row.locator('[data-slot="outcome"]')).toContainText("kestrel benchmark");
    await expect(row.locator('[data-slot="duration"]')).toHaveText("41m");
    await expect(row.locator('[data-slot="commits"]')).toHaveText("1 commit");
    await expect(row.locator('[data-slot="prs"]')).toHaveText("0 PRs");
    // One record per session across live and archived.
    const ids = await page
      .locator('[data-testid="project-session"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-session-id")));
    expect(new Set(ids).size).toBe(ids.length);
    expect(await axeViolations(page, `${theme} archived rows`)).toEqual([]);
    expectAllReadable(await measureAllText(page), `${theme} archived rows`);
    await fullShot(page, theme === "dark" ? "R5.3-mock.png" : "R5.3-mock-light.png");
  });
}

test("R5.3 hostile characters in archive text are shown, not obeyed", async ({ page }) => {
  await openMockProject(page, "bb2dash");
  const row = page.getByTestId("archived-list").locator('[data-session-id="mock-archived-04"]');
  await expect(row).toContainText("<U+202E>");
  expect(await row.textContent()).not.toContain(RLO);
});

test("R5.3 palette: an outcome word opens that archived session", async ({ page }) => {
  await openMockProject(page, "bb2dash");
  await page.keyboard.press("Control+k");
  const palette = page.getByTestId("command-palette");
  await expect(palette.getByRole("combobox")).toBeFocused();
  await page.keyboard.type("kestrel");
  await expect(palette).toHaveAttribute("data-results-for", "kestrel");
  const hit = palette.getByRole("option").first();
  await expect(hit).toHaveAttribute("data-result-id", "mock-archived-01");
  await expect(hit).toContainText("Archived");
  await page.keyboard.press("Enter");
  const drawer = page.getByTestId("detail-drawer");
  await expect(drawer).toHaveAttribute("data-session-id", "mock-archived-01");
  await expect(drawer.locator('[data-slot="archive-outcome"]')).toContainText("kestrel benchmark");
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
});

test("R5.3 session list: archived rows carry the archive line", async ({ page }) => {
  await openMockProject(page, "bb2dash");
  await page.goto("/sessions");
  const row = page.locator('[data-testid="session-list-row"][data-session-id="mock-archived-01"]');
  await page.getByRole("searchbox").fill("Archived run 1");
  await expect(row).toBeVisible();
  await expect(row.locator('[data-slot="state"]')).toContainText("Archived");
  await expect(row.locator('[data-slot="outcome"]')).toContainText("kestrel");
});
