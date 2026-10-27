import { expect, test, type Page } from "@playwright/test";
import { freezeClock, shot, waitForReplayDone } from "./helpers";
import { LIVE } from "./live-helpers";

/**
 * R6.2: `a` (arrange for N live sessions) picks the expected preset for 0..8 live sessions and
 * places the most urgent ones in attention order; `p` splits by project. The mock replay gives a
 * fixed board, so the count is varied by replacing the store's session set through the page's
 * exposed store (mock build only), cloning replayed sessions so the cards are real.
 */
test.skip(LIVE.hubUrl !== "", "mock build only");

const TABLE: [number, string, number][] = [
  [0, "strip", 1],
  [1, "solo", 2],
  [2, "pair", 2],
  [3, "focus", 4],
  [4, "quad", 4],
  [5, "grid6", 6],
  [6, "grid6", 6],
  [7, "grid6", 6],
  [8, "grid6", 6],
];

/** n live clones c1..cn (c1 newest) plus one ended session that must never be placed. */
async function setLive(page: Page, n: number): Promise<void> {
  await page.evaluate((count) => {
    type Row = Record<string, unknown>;
    const store = (
      window as unknown as {
        __sd: {
          board: {
            getState: () => { sessions: Record<string, Row>; replaceAll: (l: Row[]) => void };
          };
        };
      }
    ).__sd.board;
    const base = Object.values(store.getState().sessions)[0]!;
    const list: Row[] = Array.from({ length: count }, (_, i) => ({
      ...base,
      session_id: `c${i + 1}`,
      session_name: `clone ${i + 1}`,
      project_dir: `/w/proj${(i % 3) + 1}`,
      state: "working",
      subagents: [],
      last_event_at: 1_000_000 - i,
    }));
    list.push({
      ...base,
      session_id: "dead",
      session_name: "dead",
      state: "ended",
      last_event_at: 9_999_999,
    });
    store.getState().replaceAll(list);
  }, n);
}

const placed = (page: Page) =>
  page
    .locator('[data-pane-type="session"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-session-id")));

for (const [n, preset, panes] of TABLE) {
  test(`R6.2 ${n} live -> ${preset}`, async ({ page }) => {
    await freezeClock(page);
    await page.goto("/layout?replay=fast&preset=pair");
    await waitForReplayDone(page);
    await setLive(page, n);
    await page.keyboard.press("a");
    await expect(page.getByTestId("layout")).toHaveAttribute("data-layout-id", preset);
    await expect(page.getByTestId("pane")).toHaveCount(panes);
    const want = Array.from({ length: Math.min(n, 6) }, (_, i) => `c${i + 1}`);
    const got = (await placed(page)).filter((x) => x !== null);
    expect(got).toEqual(want);
    expect(got).not.toContain("dead");
    if (n > 6)
      await expect(page.getByTestId("sessions-more")).toHaveText(
        new RegExp(`\\+${n - 6} more live sessions?`),
      );
    await page.screenshot({ path: shot(`R6.2-autofit-${n}.png`) });
  });
}

test("R6.2 the mock board: a arranges, p splits by project, both are reachable by key alone", async ({
  page,
}) => {
  await freezeClock(page);
  await page.goto("/layout?replay=fast");
  await waitForReplayDone(page);
  await page.keyboard.press("a");
  const id = await page.getByTestId("layout").getAttribute("data-layout-id");
  expect(["solo", "pair", "focus", "quad", "grid6"]).toContain(id);
  await expect(page.getByTestId("layout-notice")).toContainText(/Arranged \d+ live sessions?/);
  await page.keyboard.press("p");
  await expect(page.getByTestId("layout")).toHaveAttribute("data-layout-id", "by-project");
  await expect(page.getByTestId("layout-notice")).toContainText(/by project/);
  await page.screenshot({ path: shot("R6.2-by-project-mock.png") });
});

test("R6.2 arranged layout survives a reload with its assignments", async ({ page }) => {
  await freezeClock(page);
  await page.goto("/layout?replay=fast");
  await waitForReplayDone(page);
  await setLive(page, 4);
  await page.keyboard.press("a");
  await expect(page.getByTestId("layout")).toHaveAttribute("data-layout-id", "quad");
  const before = await placed(page);
  await page.reload();
  await waitForReplayDone(page);
  expect(await placed(page)).toEqual(before);
});
