import { expect, test, type Page } from "@playwright/test";
import { freezeClock, shot, waitForReplayDone } from "./helpers";

/**
 * R6.1: every builtin preset renders at 1440x900 and 2560x1440 with the mock replay, no pane has
 * zero size, panes tile the layout area, and a reload shows the same layout (persisted spec).
 */
const PRESETS = [
  ["solo", 2],
  ["pair", 2],
  ["quad", 4],
  ["focus", 4],
  ["grid6", 6],
  ["by-project", null],
  ["strip", 1],
] as const;
const SIZES = [
  [1440, 900],
  [2560, 1440],
] as const;

interface PaneBox {
  id: string | null;
  type: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

async function paneBoxes(page: Page): Promise<PaneBox[]> {
  return page.getByTestId("pane").evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return {
        id: e.getAttribute("data-pane-id"),
        type: e.getAttribute("data-pane-type"),
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    }),
  );
}

const storedSpec = (page: Page) => page.evaluate(() => window.localStorage.getItem("sd.layout"));

for (const [w, h] of SIZES) {
  for (const [preset, expected] of PRESETS) {
    test(`R6.1 ${preset} at ${w}x${h}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await freezeClock(page);
      await page.goto(`/layout?replay=fast&preset=${preset}`);
      await waitForReplayDone(page);
      await expect(page.getByTestId("layout")).toHaveAttribute("data-layout-id", preset);
      await expect(page).not.toHaveURL(/preset=/);
      const area = await page.getByTestId("layout").boundingBox();
      expect(area).not.toBeNull();

      const boxes = await paneBoxes(page);
      if (expected !== null) expect(boxes).toHaveLength(expected);
      else expect(boxes.length).toBeGreaterThanOrEqual(2);
      // by-project with many columns scrolls sideways instead of squeezing the cards.
      const scrolls = (await page.getByTestId("split-scroll").count()) > 0;
      for (const b of boxes) {
        expect(b.w, `${b.id} width`).toBeGreaterThan(40);
        expect(b.h, `${b.id} height`).toBeGreaterThan(40);
        // Panes sit inside the layout area (1 px for the gutters).
        expect(b.x).toBeGreaterThanOrEqual(Math.floor(area!.x) - 1);
        expect(b.y).toBeGreaterThanOrEqual(Math.floor(area!.y) - 1);
        if (!scrolls) expect(b.x + b.w).toBeLessThanOrEqual(Math.ceil(area!.x + area!.width) + 1);
        expect(b.y + b.h).toBeLessThanOrEqual(Math.ceil(area!.y + area!.height) + 1);
      }
      if (scrolls) {
        // Readable columns: every column holds a whole card (28 rem) and no card is cut off inside
        // its pane. The row itself scrolls, and it stays inside the layout area.
        const sc = page.getByTestId("split-scroll");
        const m = await sc.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth }));
        expect(m.sw).toBeGreaterThan(m.cw);
        const clipped = await page.locator('[data-pane-type="project"]').evaluateAll((panes) =>
          panes.flatMap((p) => {
            const pr = p.getBoundingClientRect();
            return [...p.querySelectorAll('[data-testid="session-card"]')]
              .map((c) => c.getBoundingClientRect())
              .filter((r) => r.right > pr.right + 1 || r.left < pr.left - 1)
              .map(() => p.getAttribute("data-pane-id"));
          }),
        );
        expect(clipped).toEqual([]);
        for (const b of boxes) expect(b.w, `${b.id} readable width`).toBeGreaterThanOrEqual(440);
      }
      // Fixed pane header geometry: 28 px on every pane.
      const heads = await page
        .locator('[data-testid="pane"] > header')
        .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
      expect(new Set(heads)).toEqual(new Set([28]));
      if (preset === "solo") {
        const board = boxes.find((b) => b.type === "board")!;
        expect(board.h).toBeGreaterThanOrEqual(64);
        expect(board.h).toBeLessThan(h / 4);
      }
      if (preset === "focus") {
        const sorted = [...boxes].sort((a, b) => b.w * b.h - a.w * a.h);
        expect(sorted[0]!.w * sorted[0]!.h).toBeGreaterThan(2 * sorted[1]!.w * sorted[1]!.h);
      }
      await page.screenshot({ path: shot(`R6.1-${preset}-${w}x${h}.png`) });

      const before = await storedSpec(page);
      expect(before).not.toBeNull();
      await page.reload();
      await waitForReplayDone(page);
      await expect(page.getByTestId("layout")).toHaveAttribute("data-layout-id", preset);
      expect(await storedSpec(page)).toBe(before);
      const after = await paneBoxes(page);
      expect(after.map((b) => [b.id, b.type, b.w, b.h])).toEqual(
        boxes.map((b) => [b.id, b.type, b.w, b.h]),
      );
    });
  }
}

test("R6.1 menu is reachable by keyboard and a chosen preset survives reload", async ({ page }) => {
  await freezeClock(page);
  await page.goto("/layout?replay=fast");
  await waitForReplayDone(page);
  await page.keyboard.press("l");
  await expect(page.getByRole("menu", { name: "Layout presets" })).toBeVisible();
  await page.getByRole("menuitemradio", { name: /Quad/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("pane")).toHaveCount(4);
  await page.reload();
  await waitForReplayDone(page);
  await expect(page.getByTestId("pane")).toHaveCount(4);
});
