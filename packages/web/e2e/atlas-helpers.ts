import { expect, type Locator, type Page } from "@playwright/test";
import { openSettledBoard } from "./helpers";

/** Header nav link, then the project link in the list. Client-side navigation keeps the mock store. */
export async function openProjectByName(page: Page, name: string): Promise<void> {
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Projects" })
    .click();
  await expect(page.getByTestId("projects-list")).toBeVisible();
  await page.getByTestId("projects-list").getByRole("link", { name, exact: true }).click();
  await expect(page.getByTestId("project-name")).toContainText(name);
  await expect(page.getByTestId("totals").locator('[data-slot="sessions"]')).not.toHaveText("n/a");
}

export async function openMockProject(page: Page, name: string): Promise<void> {
  await openSettledBoard(page);
  await openProjectByName(page, name);
}

export const sessionRow = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="project-session"][data-session-id="${id}"]`);

/** Keyboard-only edit of a phase chip: focus, Enter opens, type, Enter saves. */
export async function editPhaseWithKeyboard(page: Page, row: Locator, text: string): Promise<void> {
  const chip = row.getByRole("button", { name: /^Phase for/ });
  await chip.focus();
  await page.keyboard.press("Enter");
  const input = row.getByRole("textbox", { name: /^Phase for/ });
  await expect(input).toBeFocused();
  await page.keyboard.press("Control+a");
  if (text === "") await page.keyboard.press("Delete");
  else await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await expect(input).toHaveCount(0);
}
