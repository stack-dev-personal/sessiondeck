import { expect, test, type Page } from "@playwright/test";
import {
  freezeClock,
  setTheme,
  shot,
  waitForCards,
  waitForReplayDone,
  type Theme,
} from "./helpers";

/**
 * R3.16: transcript-derived figures are labelled, cost reads API-equivalent, context with no window
 * shows tokens only. Screenshots go to SCREENS_DIR as R3.16-<view>-<theme>-<width>.png.
 */
const SIZES = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;
const THEMES: Theme[] = ["light", "dark"];
const HEADLESS = "headless-mock-1";

async function openBoard(page: Page): Promise<void> {
  await freezeClock(page);
  await page.goto("/board?replay=fast&headless=1");
  await waitForReplayDone(page);
  await waitForCards(page, 9);
}

const cardOf = (page: Page, id: string) =>
  page.getByTestId("session-card").and(page.locator(`[data-session-id="${id}"]`));

test("R3.16 headless card and drawer: figures, no percent, API-equivalent, accessible marker", async ({
  page,
}) => {
  await setTheme(page, "dark");
  await openBoard(page);
  const card = cardOf(page, HEADLESS);

  const ctx = card.locator('[data-meter="context"]');
  await expect(ctx).toContainText("94k tok");
  await expect(ctx).not.toContainText("%");
  await expect(ctx).toHaveAttribute("aria-label", /94172 tokens.*from transcript/);
  await expect(ctx.locator('[data-slot="bar"] > span')).toHaveCount(0);

  const cost = card.locator('[data-slot="cost"]');
  await expect(cost).toContainText("$2.09");
  await expect(cost).toHaveAttribute("aria-label", "API-equivalent cost $2.09, from transcript");
  await expect(cost).toHaveAttribute("title", "API-equivalent cost $2.09, from transcript");
  await expect(card.locator('[data-slot="model"]')).toContainText("Opus");
  await expect(card.locator('[data-slot="model"]')).toHaveAccessibleName(/from transcript/);

  // Keyboard and screen reader reach the same text through the card's description.
  await card.focus();
  await expect(card).toHaveAccessibleDescription(/Cost, context.* are from transcript/);

  await page.keyboard.press("Enter");
  const drawer = page.getByTestId("detail-drawer");
  await expect(drawer).toBeVisible();
  const figures = drawer.locator('[data-slot="figures"]');
  await expect(figures).toContainText("claude-opus-5-5");
  await expect(figures).toContainText("94k tok");
  await expect(figures).not.toContainText("%");
  await expect(figures).toContainText("API-equivalent");
  await expect(figures).toContainText("$2.09");
  await expect(figures.getByText("from transcript")).toHaveCount(3);

  const rows = drawer.locator('[data-section="subagents"] tbody tr');
  await expect(rows).toHaveCount(2);
  for (const [i, tokens] of ["32k", "26k"].entries()) {
    await expect(rows.nth(i)).toContainText("claude-sonnet-5-5");
    await expect(rows.nth(i)).toContainText("medium");
    await expect(rows.nth(i)).toContainText(tokens);
    await expect(rows.nth(i).locator('[data-source="transcript"]')).toHaveText(/from transcript/);
  }
});

test("R3.16 statusline sessions show no transcript marker", async ({ page }) => {
  await setTheme(page, "dark");
  await openBoard(page);
  const others = page
    .getByTestId("session-card")
    .and(page.locator(`:not([data-session-id="${HEADLESS}"])`));
  await expect(others).toHaveCount(8);
  await expect(others.locator('[data-source="transcript"]')).toHaveCount(0);
  const text = await others.evaluateAll((els) => els.map((e) => e.textContent ?? "").join("|"));
  expect(text).not.toContain("from transcript");

  const first = others.first();
  await expect(first.locator('[data-slot="cost"]')).toHaveAttribute(
    "aria-label",
    /^API-equivalent cost (\$\d+\.\d\d|n\/a)$/,
  );
  await first.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByTestId("detail-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[data-source="transcript"]')).toHaveCount(0);
});

for (const size of SIZES) {
  for (const theme of THEMES) {
    test(`R3.16 screenshots ${theme} ${size.width}`, async ({ page }) => {
      await page.setViewportSize(size);
      await setTheme(page, theme);
      await openBoard(page);
      const card = cardOf(page, HEADLESS);
      await card.scrollIntoViewIfNeeded();
      await card.screenshot({ path: shot(`R3.16-card-${theme}-${size.width}.png`) });
      await card.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("detail-drawer")).toBeVisible();
      await expect(page.getByTestId("detail-drawer")).toContainText("API-equivalent");
      await page.screenshot({ path: shot(`R3.16-drawer-${theme}-${size.width}.png`) });
    });
  }
}
