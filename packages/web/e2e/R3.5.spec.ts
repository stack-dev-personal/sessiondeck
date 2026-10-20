import { expect, test, type Page } from "@playwright/test";
import { shot, waitForCards } from "./helpers";

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
  await page.goto("/board");
  await waitForCards(page, 8);

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
  await page.screenshot({ path: shot("R3.5-drawer.png") });

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
