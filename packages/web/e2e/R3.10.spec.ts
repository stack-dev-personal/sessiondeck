import { expect, test, type Page } from "@playwright/test";
import { evidence, openThemed, THEMES, VIEWPORTS } from "./helpers";

const FLAP_ID = "mock-sessiondeck-3";
const row = (page: Page, id: string) => page.locator(`[data-row="${id}"]`);
const order = (page: Page) =>
  page.getByTestId("board-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-row")));
const flap = (page: Page, name: "Stop" | "UserPromptSubmit") =>
  page.evaluate(
    (n) => (window as unknown as { __sdMock: { flap: (n: string) => void } }).__sdMock.flap(n),
    name,
  );

/**
 * R3.10: a session that flaps Stop / prompt stays in the working group (the clock is frozen, so
 * the grace period never lapses) and the board order does not change. flap=0 turns the timer off;
 * the test drives the cycle by hand.
 */
for (const theme of THEMES) {
  for (const vp of VIEWPORTS) {
    test(`R3.10 flapping session keeps its place (${theme}, ${vp.w})`, async ({ page }) => {
      await openThemed(page, theme, vp, "&flap=0");
      const before = await order(page);
      const group = await row(page, FLAP_ID).getAttribute("data-group");
      expect(group).toBe("working");

      for (let i = 0; i < 3; i++) {
        await flap(page, "Stop");
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(0))));
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(0))));
        await expect(row(page, FLAP_ID)).toHaveAttribute("data-group", "working");
        expect(await order(page)).toEqual(before);
        await flap(page, "UserPromptSubmit");
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(0))));
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(0))));
        await expect(row(page, FLAP_ID)).toHaveAttribute("data-group", "working");
        expect(await order(page)).toEqual(before);
      }
      await page.screenshot({ path: evidence("R3.10", theme, vp.w) });
    });
  }
}
