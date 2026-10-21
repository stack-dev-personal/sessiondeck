import { expect, test } from "@playwright/test";
import { fullShot, openSettledBoard, waitForCards, waitForReplayDone } from "./helpers";

test("R3.4 c toggles compact rows and the choice survives a reload", async ({ page }) => {
  await openSettledBoard(page);
  const cards = page.getByTestId("session-card");
  await expect(cards.first()).toHaveAttribute("data-density", "full");

  await page.keyboard.press("c");
  await expect(cards.first()).toHaveAttribute("data-density", "compact");
  for (const h of await cards.evaluateAll((els) =>
    els.map((e) => e.getBoundingClientRect().height),
  )) {
    expect(h).toBe(36);
  }
  await fullShot(page, "R3.4-compact.png", { baseline: true });

  await page.reload();
  await waitForReplayDone(page);
  await waitForCards(page, 8);
  await expect(cards.first()).toHaveAttribute("data-density", "compact");
  expect(await page.evaluate(() => window.localStorage.getItem("sd.compact"))).toBe("1");

  await page.keyboard.press("c");
  await expect(cards.first()).toHaveAttribute("data-density", "full");
});
