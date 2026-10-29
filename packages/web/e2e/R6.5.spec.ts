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

/**
 * Replaces the board with n live clones c1..cn (mock build; the page exposes its store), so `a`
 * has exactly n sessions to place. Same approach as R6.2.
 */
async function setLive(page: Page, n: number): Promise<void> {
  await page.evaluate(async (count) => {
    type Row = Record<string, unknown>;
    const store = (
      window as unknown as {
        __sd: {
          board: {
            getState: () => {
              sessions: Record<string, Row>;
              replaceAll: (l: Row[]) => void;
              enqueueSnapshot: (s: Row) => void;
            };
          };
        };
      }
    ).__sd.board;
    const base = Object.values(store.getState().sessions)[0]!;
    store.getState().replaceAll(
      Array.from({ length: count }, (_, i) => ({
        ...base,
        session_id: `c${i + 1}`,
        session_name: `clone ${i + 1}`,
        project_dir: `/w/proj${(i % 3) + 1}`,
        state: i % 2 === 0 ? "working" : "idle",
        subagents: [],
        last_event_at: 1_000_000 - i,
      })),
    );
    // A few updates, one frame apart, so every pane's live list has rows to show.
    for (let round = 1; round <= 4; round++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      for (const s of Object.values(store.getState().sessions)) {
        const ctx = s["context"] as Record<string, unknown>;
        store.getState().enqueueSnapshot({
          ...s,
          last_event_at: (s["last_event_at"] as number) + round,
          context: { ...ctx, used_pct: 10 * round + 3 },
        });
      }
    }
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  }, n);
}

/** Which session each session pane holds, in reading order (null for an unassigned pane). */
const held = (page: Page) =>
  page
    .locator('[data-pane-type="session"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-session-id")));

/** quad, one splitter dragged to an odd ratio, one pane compacted by hand. */
async function messyQuad(page: Page): Promise<void> {
  await freezeClock(page);
  await page.goto("/layout?replay=fast&preset=pair");
  await waitForReplayDone(page);
  // Four live sessions, then Arrange: a quad with every pane holding a session, so the compacted
  // and restored screenshots show populated panes.
  await setLive(page, 4);
  await page.keyboard.press("a");
  await expect(page.getByTestId("layout")).toHaveAttribute("data-layout-id", "quad");
  await expect(page.getByTestId("pane")).toHaveCount(4);
  expect(await held(page)).toEqual(["c1", "c2", "c3", "c4"]);
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
  const heldBefore = await held(page);

  await page.keyboard.press("Shift+C");
  await expect(page.locator('[data-testid="pane"][data-compact="true"]')).toHaveCount(4);
  await expect(page.getByTestId("compact-all")).toHaveAttribute("aria-pressed", "true");
  // Compacting keeps who holds what (the one-line bodies name the sessions).
  expect(await held(page)).toEqual(heldBefore);
  await expect(page.getByTestId("pane").first()).toHaveAttribute("aria-label", /clone 1/);
  expectBoxes(await boxes(page), boxesBefore);
  await page.screenshot({ path: shot("R6.5-compacted.png") });

  await page.keyboard.press("Shift+C");
  await expect(page.locator('[data-testid="pane"][data-compact="true"]')).toHaveCount(1);
  expect(await stored(page)).toEqual(specBefore);
  expect(await stored(page, "sd.layout.snapshot")).toBeNull();
  expect(await held(page)).toEqual(heldBefore);
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
  const heldBefore = await held(page);
  await page.keyboard.press("Shift+C");
  await expect(page.locator('[data-testid="pane"][data-compact="true"]')).toHaveCount(4);
  await page.reload();
  await waitForReplayDone(page);
  // The assignments are in the stored layout; the mock board is replayed again, so re-create the
  // four live clones for the panes to show them.
  await setLive(page, 4);
  expect(await held(page)).toEqual(heldBefore);
  await expect(page.locator('[data-testid="pane"][data-compact="true"]')).toHaveCount(4);
  await expect(page.getByTestId("compact-all")).toHaveAttribute("aria-pressed", "true");
  expectBoxes(await boxes(page), boxesBefore);
  await page.keyboard.press("Shift+C");
  await expect(page.locator('[data-testid="pane"][data-compact="true"]')).toHaveCount(1);
  expect(await stored(page)).toEqual(specBefore);
  expect(await held(page)).toEqual(heldBefore);
  await expect(page.getByTestId("pane").first()).toHaveAttribute("aria-label", /clone 1/);
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
