import { expect, test, type Page } from "@playwright/test";
import { freezeClock, shot, waitForReplayDone } from "./helpers";
import { LIVE } from "./live-helpers";

/**
 * R6.6: drag a card onto a pane, drag the same session onto another pane (it leaves the first),
 * assign by keyboard alone, and no session is ever in two content panes.
 */
test.skip(LIVE.hubUrl !== "", "mock build only");

/** A board strip on top and three session panes below. */
const SPEC = {
  version: 1,
  id: "r66",
  name: "R6.6",
  root: {
    kind: "split",
    dir: "column",
    ratios: [0.3, 0.7],
    children: [
      { kind: "pane", id: "board", type: "board" },
      {
        kind: "split",
        dir: "row",
        ratios: [1 / 3, 1 / 3, 1 / 3],
        children: [
          { kind: "pane", id: "s1", type: "session" },
          { kind: "pane", id: "s2", type: "session" },
          { kind: "pane", id: "s3", type: "session" },
        ],
      },
    ],
  },
};

async function open(page: Page): Promise<void> {
  await page.addInitScript((spec) => {
    try {
      if (!window.localStorage.getItem("sd.layout"))
        window.localStorage.setItem("sd.layout", JSON.stringify(spec));
    } catch {
      /* ignore */
    }
  }, SPEC);
  await freezeClock(page);
  await page.goto("/layout?replay=fast");
  await waitForReplayDone(page);
  await expect(page.getByTestId("layout")).toHaveAttribute("data-layout-id", "r66");
}

const pane = (page: Page, id: string) => page.locator(`[data-pane-id="${id}"]`);
const heldBy = (page: Page) =>
  page
    .locator('[data-pane-type="session"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-session-id")));
const stripItem = (page: Page, i: number) =>
  page.getByRole("list", { name: "Board strip" }).getByRole("listitem").nth(i);

async function expectOneEach(page: Page): Promise<void> {
  const got = (await heldBy(page)).filter((x) => x !== null);
  expect(new Set(got).size).toBe(got.length);
}

test("R6.6 drag a card onto pane 2, then the same session onto pane 3", async ({ page }) => {
  await open(page);
  const item = stripItem(page, 0);
  const id = await item.getByTestId("session-card").getAttribute("data-session-id");
  expect(id).toBeTruthy();

  // Drop target state is visible while a drag hovers.
  await item.hover();
  await item.dragTo(pane(page, "s2"));
  expect(await heldBy(page)).toEqual([null, id, null]);
  await expect(pane(page, "s2")).toHaveAttribute("data-session-id", id!);
  await page.screenshot({ path: shot("R6.6-drag.png") });

  await item.dragTo(pane(page, "s3"));
  expect(await heldBy(page)).toEqual([null, null, id]);
  await expect(pane(page, "s2")).not.toHaveAttribute("data-session-id", /.+/);
  await expectOneEach(page);

  // A second session onto the occupied pane replaces it; dragging a pane header onto another swaps.
  const other = await stripItem(page, 1)
    .getByTestId("session-card")
    .getAttribute("data-session-id");
  await stripItem(page, 1).dragTo(pane(page, "s1"));
  expect(await heldBy(page)).toEqual([other, null, id]);
  await pane(page, "s1").getByTestId("pane-header").dragTo(pane(page, "s3"));
  expect(await heldBy(page)).toEqual([id, null, other]);
  await expectOneEach(page);
  // The assignment is persisted.
  await page.reload();
  await waitForReplayDone(page);
  expect(await heldBy(page)).toEqual([id, null, other]);
  await page.screenshot({ path: shot("R6.6-invariant.png") });
});

test("R6.6 keyboard only: Tab to a pane, Enter, filter, Enter", async ({ page }) => {
  await open(page);
  // Tab until the third session pane has focus (no mouse).
  for (let i = 0; i < 120; i++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(() => document.activeElement?.getAttribute("data-pane-id") === "s3"))
      break;
  }
  await expect(pane(page, "s3")).toBeFocused();
  // The focus ring is a real outline in the accent color.
  const ring = await pane(page, "s3").evaluate((e) => {
    const c = getComputedStyle(e);
    return { w: c.outlineWidth, style: c.outlineStyle };
  });
  expect(ring.style).toBe("solid");
  expect(parseFloat(ring.w)).toBeGreaterThanOrEqual(2);
  await page.keyboard.press("Enter");
  const dlg = page.getByRole("dialog", { name: /Assign a session to pane 3/ });
  await expect(dlg).toBeVisible();
  const options = dlg.getByRole("option");
  expect(await options.count()).toBeGreaterThan(1);
  await page.screenshot({ path: shot("R6.6-keyboard.png") });
  await page.keyboard.press("ArrowDown");
  const chosen = await options.nth(1).getAttribute("data-session-id");
  await page.keyboard.press("Enter");
  await expect(dlg).toHaveCount(0);
  expect(await heldBy(page)).toEqual([null, null, chosen]);
  await expect(pane(page, "s3")).toBeFocused();

  // Assign the same session to pane 1 by keyboard: it moves.
  await pane(page, "s1").focus();
  await page.keyboard.press("g");
  await page.keyboard.type(chosen!);
  await page.keyboard.press("Enter");
  expect(await heldBy(page)).toEqual([chosen, null, null]);
  // Delete unassigns.
  await page.keyboard.press("Delete");
  expect(await heldBy(page)).toEqual([null, null, null]);
});
