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

/** Wall clock every test runs at, so elapsed times, resets and the replay are deterministic. */
export const FIXED_NOW = new Date("2026-10-20T12:00:00Z");

/** Freezes Date for the page (timers keep running); call before the first goto. */
export async function freezeClock(page: Page): Promise<void> {
  await page.clock.setFixedTime(FIXED_NOW);
}

export async function gotoDevCards(page: Page): Promise<void> {
  await freezeClock(page);
  await page.goto("/dev/cards");
  await expect(page.getByTestId("dev-cards")).toBeVisible();
  await expect(page.getByTestId("specimen-populated")).toBeVisible();
}

/** Waits for the mock replay to produce `n` cards. */
export async function waitForCards(page: Page, n: number): Promise<void> {
  await expect(page.getByTestId("session-card")).toHaveCount(n, { timeout: 30_000 });
}

/** Waits until the mock replay has delivered and flushed everything (`<html data-replay=done>`). */
export async function waitForReplayDone(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-replay", "done", { timeout: 30_000 });
}

/** Opens /board with the fast replay and the frozen clock and waits for the settled board. */
export async function openSettledBoard(page: Page, path = "/board"): Promise<void> {
  await freezeClock(page);
  await page.goto(`${path}?replay=fast`);
  await waitForReplayDone(page);
  await waitForCards(page, 8);
}

/** Settled client-side navigation (keeps the replayed store, no reload). */
export async function navigate(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    window.history.pushState({}, "", p);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
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
export async function fullShot(
  page: Page,
  name: string,
  opts: { baseline?: boolean } = {},
): Promise<void> {
  const orig = page.viewportSize()!;
  const extra = await page.evaluate(() => {
    const m = document.querySelector("main")!;
    return Math.max(0, m.scrollHeight - m.clientHeight);
  });
  await page.setViewportSize({ width: orig.width, height: orig.height + extra });
  await page.screenshot({ path: shot(name) });
  if (opts.baseline) await expect(page).toHaveScreenshot(name);
  await page.setViewportSize(orig);
}

export interface SettledMix {
  states: Record<string, number>;
  withContext: number;
  withLimits: number;
  withDots: number;
  withTasks: number;
  names: string[];
  withBranch: number;
}

/** Reads the settled board: how many cards show numbers, subagent dots and task progress. */
export async function settledMix(page: Page): Promise<SettledMix> {
  return page.getByTestId("session-card").evaluateAll((els) => {
    const num = (e: Element, sel: string) => /\d+%/.test(e.querySelector(sel)?.textContent ?? "");
    const states: Record<string, number> = {};
    for (const e of els) {
      const st = e.getAttribute("data-state") ?? "?";
      states[st] = (states[st] ?? 0) + 1;
    }
    return {
      states,
      withContext: els.filter((e) => num(e, '[data-meter="context"]')).length,
      withLimits: els.filter(
        (e) => num(e, '[data-meter="five_hour"]') && num(e, '[data-meter="seven_day"]'),
      ).length,
      withDots: els.filter((e) => e.querySelectorAll("[data-dot]").length > 0).length,
      withTasks: els.filter((e) =>
        /\d+\/\d+/.test(e.querySelector('[data-slot="tasks"]')?.textContent ?? ""),
      ).length,
      names: els.map((e) => e.querySelector('[data-slot="name"]')?.textContent ?? ""),
      withBranch: els.filter((e) => {
        const where = e.querySelector('[data-row="1"] > span:last-child')?.textContent ?? "";
        const branch = where.split(" · ")[1] ?? "n/a";
        return !branch.startsWith("n/a");
      }).length,
    };
  });
}
