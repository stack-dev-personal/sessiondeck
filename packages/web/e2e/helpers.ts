import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { SCREENS_DIR } from "./screens-dir";

mkdirSync(SCREENS_DIR, { recursive: true });
export const shot = (name: string) => join(SCREENS_DIR, name);

export type Theme = "dark" | "light";

/** Sets the persisted theme before any page script runs (same key the app uses). */
export async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript((t) => {
    try {
      window.localStorage.setItem("sd.theme", t);
    } catch {
      /* ignore */
    }
  }, theme);
}

export async function gotoDevCards(page: Page): Promise<void> {
  await page.goto("/dev/cards");
  await expect(page.getByTestId("dev-cards")).toBeVisible();
  await expect(page.getByTestId("specimen-populated")).toBeVisible();
}

/** Waits for the mock replay to produce `n` cards. */
export async function waitForCards(page: Page, n: number): Promise<void> {
  await expect(page.getByTestId("session-card")).toHaveCount(n, { timeout: 30_000 });
}

export const STATES = [
  ["starting", "◌", "Starting"],
  ["working", "●", "Working"],
  ["waiting_permission", "▲", "Needs permission"],
  ["waiting_input", "▲", "Needs input"],
  ["idle", "○", "Idle"],
  ["error", "✖", "Error"],
  ["ended", "■", "Ended"],
  ["exited", "◆", "Exited"],
] as const;

/**
 * The app scrolls inside <main>, so Playwright's fullPage cannot see the overflow. Grow the
 * viewport to the content height, shoot, then restore it.
 */
export async function fullShot(page: Page, name: string): Promise<void> {
  const orig = page.viewportSize()!;
  const extra = await page.evaluate(() => {
    const m = document.querySelector("main")!;
    return Math.max(0, m.scrollHeight - m.clientHeight);
  });
  await page.setViewportSize({ width: orig.width, height: orig.height + extra });
  await page.screenshot({ path: shot(name) });
  await page.setViewportSize(orig);
}
