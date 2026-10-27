import { expect, test, type Page } from "@playwright/test";
import { freezeClock, shot, waitForReplayDone } from "./helpers";
import { LIVE } from "./live-helpers";
import { pickPreset } from "./saved-helpers";

/**
 * R6.5: Shift+C compacts every pane; Shift+C again restores the previous layout exactly: the stored
 * spec is deep-equal to the one before and every pane box matches within 1 px, also across a reload
 * between the two presses.
 */
test.skip(LIVE.hubUrl !== "", "mock build only");

const stored = (page: Page, key = "sd.layout") =>
  page
    .evaluate((k) => window.localStorage.getItem(k), key)
    .then((s) => (s === null ? null : (JSON.parse(s) as unknown)));

async function boxes(page: Page) {
  return page.getByTestId("pane").evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { id: e.getAttribute("data-pane-id"), x: r.x, y: r.y, w: r.width, h: r.height };
    }),
  );
}
function expectBoxes(a: Awaited<ReturnType<typeof boxes>>, b: Awaited<ReturnType<typeof boxes>>) {
  expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
  for (const [i, x] of a.entries())
    for (const k of ["x", "y", "w", "h"] as const)
      expect(Math.abs(x[k] - b[i]![k]), `${x.id}.${k}`).toBeLessThanOrEqual(1);
}

/** quad, one splitter dragged to an odd ratio, one pane compacted by hand. */
async function messyQuad(page: Page): Promise<void> {
  await freezeClock(page);
  await page.goto("/layout?replay=fast&preset=quad");
  await waitForReplayDone(page);
  await expect(page.getByTestId("pane")).toHaveCount(4);
  // The root split's own divider (nested dividers come first in document order).
  const root = page.getByTestId("split").first();
  const horizontal = (await root.getAttribute("data-dir")) === "row";
  const b = (await root.locator(":scope > [role=separator]").boundingBox())!;
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(horizontal ? x + 137 : x, horizontal ? y : y + 91, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const spec = (await stored(page)) as { root: { ratios: number[] } };
      return Math.abs(spec.root.ratios[0]! - 0.5);
    })
    .toBeGreaterThan(0.03);
  await page.getByRole("button", { name: "Compact Session pane" }).nth(1).click();
  await expect(page.locator('[data-testid="pane"][data-compact="true"]')).toHaveCount(1);
}

test("R6.5 Shift+C compacts all panes, Shift+C restores the layout exactly", async ({ page }) => {
  await messyQuad(page);
  const specBefore = await stored(page);
  const boxesBefore = await boxes(page);
  const compactBefore = await page
    .locator('[data-testid="pane"]')
    .evaluateAll((e) => e.map((x) => x.getAttribute("data-compact")));

  await page.keyboard.press("Shift+C");
  await expect(page.locator('[data-testid="pane"][data-compact="true"]')).toHaveCount(4);
  await expect(page.getByTestId("compact-all")).toHaveAttribute("aria-pressed", "true");
  expectBoxes(await boxes(page), boxesBefore);
  await page.screenshot({ path: shot("R6.5-compacted.png") });

  await page.keyboard.press("Shift+C");
  await expect(page.locator('[data-testid="pane"][data-compact="true"]')).toHaveCount(1);
  expect(await stored(page)).toEqual(specBefore);
  expect(await stored(page, "sd.layout.snapshot")).toBeNull();
  expect(
    await page
      .locator('[data-testid="pane"]')
      .evaluateAll((e) => e.map((x) => x.getAttribute("data-compact"))),
  ).toEqual(compactBefore);
  expectBoxes(await boxes(page), boxesBefore);
  await page.screenshot({ path: shot("R6.5-restored.png") });
});

test("R6.5 the restore is exact across a reload between the two presses", async ({ page }) => {
  await messyQuad(page);
  const specBefore = await stored(page);
  const boxesBefore = await boxes(page);
  await page.keyboard.press("Shift+C");
  await expect(page.locator('[data-testid="pane"][data-compact="true"]')).toHaveCount(4);
  await page.reload();
  await waitForReplayDone(page);
  await expect(page.locator('[data-testid="pane"][data-compact="true"]')).toHaveCount(4);
  await expect(page.getByTestId("compact-all")).toHaveAttribute("aria-pressed", "true");
  expectBoxes(await boxes(page), boxesBefore);
  await page.keyboard.press("Shift+C");
  await expect(page.locator('[data-testid="pane"][data-compact="true"]')).toHaveCount(1);
  expect(await stored(page)).toEqual(specBefore);
  expectBoxes(await boxes(page), boxesBefore);
  await page.screenshot({ path: shot("R6.5-restored-after-reload.png") });
});

test("R6.5 a manual expand keeps the restore; switching layout discards it; lowercase c is the board toggle", async ({
  page,
}) => {
  await messyQuad(page);
  const specBefore = await stored(page);
  await page.keyboard.press("Shift+C");
  await page.getByRole("button", { name: "Expand Session pane" }).first().click();
  await expect(page.locator('[data-testid="pane"][data-compact="true"]')).toHaveCount(3);
  await page.keyboard.press("Shift+C");
  expect(await stored(page)).toEqual(specBefore);

  await page.keyboard.press("Shift+C");
  await expect(page.locator('[data-testid="pane"][data-compact="true"]')).toHaveCount(4);
  await pickPreset(page, /Pair/, "pair");
  expect(await stored(page, "sd.layout.snapshot")).toBeNull();
  await expect(page.locator('[data-testid="pane"][data-compact="true"]')).toHaveCount(0);
  await expect(page.getByTestId("compact-all")).toHaveAttribute("aria-pressed", "false");

  // Lowercase c still toggles the board's compact cards and leaves the layout alone.
  const spec = await stored(page);
  await page.keyboard.press("c");
  await expect(page.locator("html")).toBeVisible();
  expect(await page.evaluate(() => window.localStorage.getItem("sd.compact"))).toBe("1");
  expect(await stored(page)).toEqual(spec);
});
