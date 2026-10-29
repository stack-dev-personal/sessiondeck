import { expect, test } from "@playwright/test";
import { evidence, openThemed, THEMES, VIEWPORTS } from "./helpers";

/** R3.12: no 5h/7d on cards, a movable usage widget with both windows, a chip that fits, no Fable. */
for (const theme of THEMES) {
  for (const vp of VIEWPORTS) {
    test(`R3.12 usage widget (${theme}, ${vp.w})`, async ({ page }) => {
      await openThemed(page, theme, vp);
      await expect(
        page.locator('[data-testid="session-card"] [data-meter="five_hour"]'),
      ).toHaveCount(0);
      await expect(
        page.locator('[data-testid="session-card"] [data-meter="seven_day"]'),
      ).toHaveCount(0);

      const widget = page.getByTestId("usage-widget");
      await expect(widget).toBeVisible();
      await expect(widget.locator('[data-slot="five_hour"]')).toContainText(/\d+%/);
      await expect(widget.locator('[data-slot="seven_day"]')).toContainText(/\d+%/);
      // Decision 28: no Fable usage row or estimate. Card model labels (data, e.g. "fable·xhigh") are not usage.
      expect((await widget.innerText()).toLowerCase()).not.toContain("fable");
      expect((await widget.innerText()).toLowerCase()).not.toMatch(/estimate|~\s*\d/);
      await page.screenshot({ path: evidence("R3.12", theme, vp.w) });

      // Drag by the handle; position persists after reload.
      const h = (await page.getByTestId("usage-handle").boundingBox())!;
      const start = (await widget.boundingBox())!;
      await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
      await page.mouse.down();
      await page.mouse.move(h.x - 60, h.y - 80, { steps: 6 });
      await page.mouse.up();
      await expect
        .poll(async () => {
          const b = (await widget.boundingBox())!;
          return Math.abs(b.x - start.x) + Math.abs(b.y - start.y);
        })
        .toBeGreaterThan(20);
      const moved = (await widget.boundingBox())!;
      await page.reload();
      await expect(page.getByTestId("usage-widget")).toBeVisible();
      const after = (await page.getByTestId("usage-widget").boundingBox())!;
      expect(Math.abs(after.x - moved.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(after.y - moved.y)).toBeLessThanOrEqual(1);

      // Collapse to the chip; it must fit: no clipped text, focus ring inside the box.
      await page.getByTestId("usage-collapse").click();
      await expect(page.getByTestId("usage-widget")).toHaveAttribute("data-collapsed", "true");
      const btn = page.getByTestId("usage-collapse");
      await expect(btn).toContainText(/7d\s+(\d+%|n\/a)/);
      await btn.focus();
      const fit = await page.evaluate(() => {
        const w = document.querySelector<HTMLElement>('[data-testid="usage-widget"]')!;
        const b = document.querySelector<HTMLElement>('[data-testid="usage-collapse"]')!;
        const r = w.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        const inner = w.getBoundingClientRect();
        return {
          textClipped: b.scrollWidth > b.clientWidth,
          widgetClipped: w.scrollWidth > w.clientWidth || w.scrollHeight > w.clientHeight,
          right: r.right - br.right,
          left: br.left - r.left,
          top: br.top - r.top,
          bottom: r.bottom - br.bottom,
          vw: window.innerWidth,
          vh: window.innerHeight,
          inView: inner.right <= window.innerWidth + 1 && inner.bottom <= window.innerHeight + 1,
        };
      });
      expect(fit.textClipped).toBe(false);
      expect(fit.widgetClipped).toBe(false);
      for (const gap of [fit.right, fit.left, fit.top, fit.bottom]) {
        expect(gap).toBeGreaterThanOrEqual(2); // room for the 2px focus ring
      }
      expect(fit.inView).toBe(true);
      await page.screenshot({ path: evidence("R3.12-chip", theme, vp.w) });
    });
  }
}
