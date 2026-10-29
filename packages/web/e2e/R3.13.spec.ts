import { expect, test } from "@playwright/test";
import { evidence, openThemed, THEMES, VIEWPORTS } from "./helpers";

/** R3.13: the mock scenario carries the flapping session, three nesting levels and the usage widget. */
for (const theme of THEMES) {
  for (const vp of VIEWPORTS) {
    test(`R3.13 mock scenario covers R3.10-R3.12 (${theme}, ${vp.w})`, async ({ page }) => {
      await openThemed(page, theme, vp);
      await expect(page.locator('[data-row="mock-sessiondeck-3"]')).toHaveAttribute(
        "data-group",
        "working",
      );
      await expect(
        page.getByTestId("usage-widget").locator('[data-slot="five_hour"]'),
      ).toContainText(/\d+%/);
      await page
        .locator('[data-testid="session-card"][data-session-id="mock-sessiondeck-3"]')
        .click();
      await page.getByTestId("agent-expand-all").click();
      const depths = await page
        .getByRole("dialog")
        .locator("[data-depth]")
        .evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-depth"))));
      expect(new Set(depths).size).toBeGreaterThanOrEqual(3);
      await page.screenshot({ path: evidence("R3.13", theme, vp.w) });

      // usage=none: the widget shows its empty state.
      await page.goto("/board?replay=fast&usage=none");
      await expect(page.getByTestId("usage-empty")).toBeVisible({ timeout: 30_000 });
    });
  }
}
