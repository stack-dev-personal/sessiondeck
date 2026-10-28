import { expect, test } from "@playwright/test";
import { openMockProject, openProjectByName, sessionRow } from "./atlas-helpers";
import { fullShot, openSettledBoard, setTheme } from "./helpers";

// R5.1: every live session belongs to exactly one project; a worktree session shows under the repo
// project; a mis-assignment is fixed by reassigning the session. Mock build (VITE_MOCK=1).

const WT = "mock-bb2dash-1";

test("R5.1 the worktree session is under its repo project; the card and drawer name the project", async ({
  page,
}) => {
  await openSettledBoard(page);
  const card = page.locator(`[data-testid="session-card"][data-session-id="${WT}"]`);
  await expect(card.locator('[data-slot="where"]')).toContainText("bb2dash · feat/chart-widgets");
  await expect(card.locator('[data-slot="where"] [data-slot="swatch"]')).toBeVisible();

  // Fixed geometry: every card has the same height whether or not it has a project color.
  const heights = await page
    .getByTestId("session-card")
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  expect(new Set(heights).size).toBe(1);

  await card.focus();
  await page.keyboard.press("Enter");
  const atlas = page.getByTestId("drawer-atlas");
  await expect(atlas.getByTestId("project-link")).toContainText("bb2dash");
  await page.keyboard.press("Escape");

  await openProjectByName(page, "bb2dash");
  const row = sessionRow(page, WT);
  await expect(row).toBeVisible();
  await expect(row.locator('[data-slot="where"]')).toContainText("worktree bb2dash-charts");
  await expect(page.locator('[data-section="live"] [data-slot="count"]')).toHaveText("1");
});

test("R5.1 reassign a session to another project with the keyboard, then undo", async ({
  page,
}) => {
  await openMockProject(page, "bb2dash");
  const row = sessionRow(page, WT);
  const move = row.getByLabel(/^Move .* to project$/);
  await move.focus();
  await move.selectOption({ label: "harvest" });
  await expect(sessionRow(page, WT)).toHaveCount(0);
  await expect(page.locator('[data-section="live"]')).toContainText("No live sessions");

  // The board card follows.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Board" }).click();
  const card = page.locator(`[data-testid="session-card"][data-session-id="${WT}"]`);
  await expect(card.locator('[data-slot="where"]')).toContainText("harvest · feat/chart-widgets");

  await openProjectByName(page, "harvest");
  await expect(sessionRow(page, WT)).toBeVisible();
  await expect(page.locator('[data-section="live"] [data-slot="count"]')).toHaveText("2");
  await fullShot(page, "R5.1.png");

  // Undo: clear the manual assignment, the session re-infers to the repo project.
  await sessionRow(page, WT)
    .getByLabel(/^Move .* to project$/)
    .selectOption({ label: "Clear manual assignment (re-infer)" });
  await expect(sessionRow(page, WT)).toHaveCount(0);
  await openProjectByName(page, "bb2dash");
  await expect(sessionRow(page, WT)).toBeVisible();
});

test("R5.1 light theme: project view reads and the worktree row is present", async ({ page }) => {
  await setTheme(page, "light");
  await openMockProject(page, "bb2dash");
  await expect(sessionRow(page, WT)).toBeVisible();
  await fullShot(page, "R5.1-light.png");
});
