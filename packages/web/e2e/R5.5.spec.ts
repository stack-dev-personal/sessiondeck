import { expect, test } from "@playwright/test";
import {
  editPhaseWithKeyboard,
  openMockProject,
  openProjectByName,
  sessionRow,
} from "./atlas-helpers";
import { fullShot, openSettledBoard } from "./helpers";

// R5.5 against the mock build: the mock keeps overrides in memory, so "persists" here means it survives
// leaving the page and coming back (no reload). Surviving a reload and a hub restart is R5.5-live.spec.ts.

const SD = "mock-sessiondeck-3"; // branch p3/board-mock: inferred phase P3

test("R5.5 phase edited with the keyboard only: Enter saves, Escape cancels, empty restores inferred", async ({
  page,
}) => {
  await openMockProject(page, "sessiondeck");
  const row = sessionRow(page, SD);
  const chip = row.getByTestId("phase-chip");
  await expect(chip).toContainText("P3");
  await expect(chip).toContainText("inferred");

  // Escape cancels.
  await row.getByRole("button", { name: /^Phase for/ }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.type("discard me");
  await page.keyboard.press("Escape");
  await expect(row.getByRole("textbox")).toHaveCount(0);
  await expect(chip).toContainText("P3");
  await expect(row.getByRole("button", { name: /^Phase for/ })).toBeFocused();

  // Enter saves; the source word changes to manual.
  await editPhaseWithKeyboard(page, row, "Review");
  await expect(chip).toContainText("Review");
  await expect(chip).toContainText("manual");
  await expect(page.getByTestId("phases")).toContainText("Review");

  // Leave the page and come back: the label is still there.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Board" }).click();
  await expect(page.getByTestId("session-card").first()).toBeVisible();
  await openProjectByName(page, "sessiondeck");
  await expect(sessionRow(page, SD).getByTestId("phase-chip")).toContainText("Review");
  await fullShot(page, "R5.5.png");

  // The drawer edits the same label.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Board" }).click();
  const card = page.locator(`[data-testid="session-card"][data-session-id="${SD}"]`);
  await card.focus();
  await page.keyboard.press("Enter");
  const drawerChip = page.getByTestId("drawer-atlas").getByTestId("phase-chip");
  await expect(drawerChip).toContainText("Review");
  await expect(drawerChip).toContainText("manual");
  await page
    .getByTestId("drawer-atlas")
    .getByRole("button", { name: /^Phase for/ })
    .focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape"); // closes the editor only
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Empty clears the manual label: inferred again.
  await openProjectByName(page, "sessiondeck");
  await editPhaseWithKeyboard(page, sessionRow(page, SD), "");
  await expect(sessionRow(page, SD).getByTestId("phase-chip")).toContainText("P3");
  await expect(sessionRow(page, SD).getByTestId("phase-chip")).toContainText("inferred");
});

test("R5.5 a session with a manual label from the start shows manual", async ({ page }) => {
  await openSettledBoard(page);
  await openProjectByName(page, "atlas");
  const chip = sessionRow(page, "mock-atlas-4").getByTestId("phase-chip");
  await expect(chip).toContainText("Hardening");
  await expect(chip).toContainText("manual");
});
