import { expect, test, type Page } from "@playwright/test";
import { openSettledBoard, shot } from "./helpers";

const SECTIONS = [
  "timeline",
  "context",
  "limits",
  "subagents",
  "tasks",
  "prompt",
  "assistant",
  "git",
  "raw",
];

const activeId = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset["sessionId"] ?? null);

test("R3.5 Enter opens the drawer, Esc closes it, focus returns to the same card", async ({
  page,
}) => {
  await openSettledBoard(page);

  await page.keyboard.press("j");
  const firstId = await activeId(page);
  expect(firstId).not.toBeNull();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const order = await dialog
    .locator("[data-section]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-section")));
  expect(order).toEqual(SECTIONS);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await activeId(page)).toBe(firstId);

  // Mouse: click another card; the drawer opens; Esc returns focus to it.
  const other = page.getByTestId("session-card").nth(3);
  const otherId = await other.getAttribute("data-session-id");
  expect(otherId).not.toBe(firstId);
  await other.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await activeId(page)).toBe(otherId);
});

test("R3.5 the drawer of the busiest session shows sparkline, timeline, subagents and limits", async ({
  page,
}) => {
  await openSettledBoard(page);
  const card = page.locator('[data-testid="session-card"][data-session-id="mock-sessiondeck-3"]');
  await card.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  const spark = dialog.locator('[data-section="context"]');
  await expect(spark).toContainText(/latest \d+% · \d+ samples/);
  const samples = Number(/(\d+) samples/.exec((await spark.textContent()) ?? "")?.[1]);
  expect(samples).toBeGreaterThanOrEqual(2);
  await expect(spark.locator("polyline")).toHaveCount(1);

  expect(
    await dialog.locator('[data-section="timeline"] [data-transition]').count(),
  ).toBeGreaterThan(2);
  expect(await dialog.locator('[data-section="subagents"] [data-agent]').count()).toBeGreaterThan(
    1,
  );
  await expect(dialog.locator('[data-section="limits"]')).toContainText(/\d+%/);
  await expect(dialog.locator('[data-section="tasks"]')).toContainText(/\d/);

  await page.screenshot({ path: shot("R3.5-drawer.png") });
  await expect(page).toHaveScreenshot("R3.5-drawer.png");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
