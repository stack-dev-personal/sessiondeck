import { expect, test } from "@playwright/test";
import { evidence, openThemed, THEMES, VIEWPORTS } from "./helpers";

const DEEP = "mock-sessiondeck-3";

/** R3.11: click a card, the popout opens as a dialog; Expand all shows three levels; Esc closes; deep link. */
for (const theme of THEMES) {
  for (const vp of VIEWPORTS) {
    test(`R3.11 popout, expand all, Esc, deep link (${theme}, ${vp.w})`, async ({ page }) => {
      await openThemed(page, theme, vp);
      const card = page.locator(`[data-testid="session-card"][data-session-id="${DEEP}"]`);
      await card.scrollIntoViewIfNeeded();
      await card.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId("session-popout")).toHaveAttribute("data-session-id", DEEP);
      await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#session-${DEEP}`);

      await page.getByTestId("agent-expand-all").click();
      await expect(dialog.getByTestId("agent-expand-all")).toHaveText("Collapse all");
      const depths = await dialog
        .locator("[data-depth]")
        .evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-depth"))));
      expect(new Set(depths).size).toBeGreaterThanOrEqual(3);
      await page.screenshot({ path: evidence("R3.11", theme, vp.w) });

      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");

      // Deep link: a fresh load of #session-<id> opens the popout.
      await page.goto(`/board?replay=fast#session-${DEEP}`);
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("session-popout")).toHaveAttribute("data-session-id", DEEP);
    });
  }
}
