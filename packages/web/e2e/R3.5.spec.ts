import { expect, test, type Page } from "@playwright/test";
import { openSettledBoard, shot } from "./helpers";

const activeId = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset["sessionId"] ?? null);

test("R3.5 Enter opens the popout, Esc closes it, focus returns to the same card", async ({
  page,
}) => {
  await openSettledBoard(page);

  await page.keyboard.press("j");
  const firstId = await activeId(page);
  expect(firstId).not.toBeNull();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("session-popout")).toHaveAttribute("data-session-id", firstId!);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await activeId(page)).toBe(firstId);

  // Mouse: click another card; the popout opens; Esc returns focus to it.
  const other = page.getByTestId("session-card").nth(3);
  const otherId = await other.getAttribute("data-session-id");
  expect(otherId).not.toBe(firstId);
  await other.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await activeId(page)).toBe(otherId);
});

test("R3.5 the popout of the busiest session shows header facts, subagents and the content slot", async ({
  page,
}) => {
  await openSettledBoard(page);
  const card = page.locator('[data-testid="session-card"][data-session-id="mock-sessiondeck-3"]');
  await card.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByTestId("session-popout");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-slot="state"]').first()).not.toHaveText("");
  for (const slot of ["model", "effort", "cost", "branch"]) {
    await expect(dialog.locator(`[data-slot="${slot}"]`).first()).toBeVisible();
  }
  await expect(dialog.locator('[data-slot="content"]')).toHaveCount(1);
  await expect(dialog.getByTestId("agent-rollup")).toContainText("Subagents (5)");
  expect(await dialog.getByTestId("agent-card").count()).toBeGreaterThan(1);

  await page.screenshot({ path: shot("R3.5-popout.png") });
  await expect(page).toHaveScreenshot("R3.5-popout.png");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
