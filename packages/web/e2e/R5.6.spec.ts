import { expect, test } from "@playwright/test";
import { axeViolations, expectAllReadable, measureAllText } from "./a11y-helpers";
import { openMockProject, sessionRow } from "./atlas-helpers";
import { fullShot, setTheme } from "./helpers";

// R5.6: the project view shows live sessions, the last 20 archived, totals and active branches.

for (const theme of ["dark", "light"] as const) {
  test(`R5.6 ${theme}: project view sections, counts, totals and cap`, async ({ page }) => {
    await setTheme(page, theme);
    await openMockProject(page, "bb2dash");

    const sections = await page
      .locator("[data-section]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-section")));
    expect(sections).toEqual(["totals", "branches", "live", "archived", "phases"]);

    const totals = page.getByTestId("totals");
    await expect(totals.locator('[data-slot="sessions"]')).toHaveText("26");
    await expect(totals.locator('[data-slot="hours"]')).toHaveText(/^\d+\.\d h$/);
    await expect(totals.locator('[data-slot="cost"]')).toHaveText(/^\$\d+\.\d\d$/);

    await expect(page.locator('[data-section="live"] [data-slot="count"]')).toHaveText("1");
    await expect(sessionRow(page, "mock-bb2dash-1")).toBeVisible();
    await expect(page.locator('[data-section="archived"] [data-slot="count"]')).toHaveText("20");
    await expect(page.getByTestId("archived-list").getByTestId("project-session")).toHaveCount(20);
    await expect(page.locator('[data-section="branches"]')).toContainText("feat/chart-widgets");
    await expect(page.locator('[data-section="phases"]')).toBeVisible();

    expect(await axeViolations(page, `${theme} project view`)).toEqual([]);
    expectAllReadable(await measureAllText(page), `${theme} project view`);
    await fullShot(page, theme === "dark" ? "R5.6.png" : "R5.6-light.png");
  });
}

test("R5.6 phases list shows counts; projects list shows counts", async ({ page }) => {
  await openMockProject(page, "sessiondeck");
  await expect(page.getByTestId("phases").locator('[data-phase="P3"]')).toContainText("×1");
  await page.getByRole("link", { name: "← Projects" }).click();
  await expect(page.getByTestId("projects-list")).toBeVisible();
  expect(await axeViolations(page, "projects list")).toEqual([]);
  expectAllReadable(await measureAllText(page), "projects list");
  await fullShot(page, "R5.6-projects.png");
  const rows = page.getByTestId("project-row");
  await expect(rows).toHaveCount(8);
  const bb = rows.filter({ hasText: "bb2dash" });
  await expect(bb.locator('[data-slot="sessions"]')).toHaveText("26");
  await expect(bb.locator('[data-slot="live"]')).toHaveText("1");
});
