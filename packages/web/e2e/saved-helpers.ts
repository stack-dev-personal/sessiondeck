import { writeFileSync } from "node:fs";
import type { Page, Route } from "@playwright/test";
import { shot } from "./helpers";

export interface HubRow {
  id: string;
  name: string;
  hotkey: number | null;
  host: string | null;
  spec: Record<string, unknown>;
  updated_at: number;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, PUT, DELETE, OPTIONS",
};

/**
 * An in-memory stand-in for the hub's /layouts routes (packages/hub/src/routes/layouts.ts): bearer
 * check, slot moves within a host scope, active_hotkey, 204 on delete. Served through page.route,
 * so the page makes real fetch calls and the test can read what the "hub" holds.
 */
export class FakeHub {
  rows: HubRow[] = [];
  readonly token = "fake-token";
  calls: string[] = [];
  /** Set to a status to make the next write fail with it (one shot). */
  failNext: number | null = null;

  constructor(readonly origin = "http://fakehub.test") {}

  async install(page: Page): Promise<void> {
    await page.addInitScript(
      (s) => {
        try {
          window.localStorage.setItem("sd.settings", JSON.stringify(s));
        } catch {
          /* ignore */
        }
      },
      { hubUrl: this.origin, token: this.token, notifications: false },
    );
    await page.route(`${this.origin}/**`, (r) => this.handle(r));
  }

  private json(route: Route, status: number, body?: unknown) {
    return route.fulfill({
      status,
      headers: { ...CORS, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? "" : JSON.stringify(body),
    });
  }

  private active(host: string | null) {
    const pinned = new Set(
      host === null
        ? []
        : this.rows.filter((r) => r.host === host && r.hotkey !== null).map((r) => r.hotkey),
    );
    return (r: HubRow) =>
      r.hotkey === null
        ? false
        : r.host === null
          ? !pinned.has(r.hotkey)
          : host !== null && r.host === host;
  }

  private async handle(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    this.calls.push(`${req.method()} ${url.pathname}`);
    if (req.method() === "OPTIONS") return this.json(route, 204);
    if (req.headers()["authorization"] !== `Bearer ${this.token}`) return this.json(route, 401);
    if (req.method() === "GET" && url.pathname === "/layouts") {
      const host = url.searchParams.get("host");
      const act = this.active(host);
      return this.json(route, 200, {
        layouts: this.rows.map((r) => ({ ...r, active_hotkey: act(r) })),
      });
    }
    const m = /^\/layouts\/([^/]+)$/.exec(url.pathname);
    if (!m) return this.json(route, 404);
    const id = decodeURIComponent(m[1]!);
    if (req.method() !== "GET" && this.failNext !== null) {
      const s = this.failNext;
      this.failNext = null;
      return this.json(route, s);
    }
    if (req.method() === "PUT") {
      const b = req.postDataJSON() as Omit<HubRow, "id" | "updated_at">;
      if (b.hotkey !== null)
        for (const r of this.rows)
          if (r.id !== id && r.hotkey === b.hotkey && r.host === b.host) r.hotkey = null;
      const row: HubRow = { id, ...b, updated_at: Date.now() };
      this.rows = [row, ...this.rows.filter((r) => r.id !== id)];
      return this.json(route, 200, { ...row, active_hotkey: this.active(row.host)(row) });
    }
    if (req.method() === "DELETE") {
      const had = this.rows.some((r) => r.id === id);
      this.rows = this.rows.filter((r) => r.id !== id);
      return this.json(route, had ? 204 : 404);
    }
    return this.json(route, 405);
  }
}

/** Number of leaf panes in a stored spec. */
export function paneCount(spec: Record<string, unknown>): number {
  const go = (n: Record<string, unknown>): number =>
    n["kind"] === "pane"
      ? 1
      : (n["children"] as Record<string, unknown>[]).reduce((a, c) => a + go(c), 0);
  return go(spec["root"] as Record<string, unknown>);
}

/** Opens the preset menu with `l` and applies a preset by name, all by keyboard. */
export async function pickPreset(page: Page, label: RegExp, id: string): Promise<void> {
  await page.keyboard.press("l");
  await page.getByRole("menuitemradio", { name: label }).focus();
  await page.keyboard.press("Enter");
  await page.locator(`[data-testid="layout"][data-layout-id="${id}"]`).waitFor();
}

/** Saves the current layout through the `s` dialog. Returns when the dialog has closed. */
export async function saveVia(
  page: Page,
  name: string,
  slot: number | null,
  opts: { screenshot?: string } = {},
): Promise<void> {
  await page.keyboard.press("s");
  const dlg = page.getByTestId("save-dialog");
  await dlg.waitFor();
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  if (slot !== null)
    await page.getByRole("combobox", { name: "Hotkey slot" }).selectOption(String(slot));
  if (opts.screenshot) await page.screenshot({ path: shot(opts.screenshot) });
  await page.getByRole("textbox", { name: "Name" }).press("Enter");
  await dlg.waitFor({ state: "detached" });
}

export interface Switch {
  key: string;
  ms: number;
}

/**
 * Presses a digit and measures, in the page, from the keydown event to the frame after the new
 * layout's panes are in the DOM (performance.now on both ends, so the test runner's latency is out).
 */
export async function pressAndMeasure(
  page: Page,
  key: string,
  expectId: string,
  expectPanes: number,
): Promise<number> {
  await page.evaluate(
    ([id, n]) => {
      const w = window as unknown as { __sw?: { t0: number | null; t1: number | null } };
      w.__sw = { t0: null, t1: null };
      const sw = w.__sw;
      const onKey = () => {
        sw.t0 = performance.now();
        window.removeEventListener("keydown", onKey, true);
      };
      window.addEventListener("keydown", onKey, true);
      const ok = () => {
        const l = document.querySelector('[data-testid="layout"]');
        return (
          l?.getAttribute("data-layout-id") === id &&
          l.querySelectorAll('[data-testid="pane"]').length === n
        );
      };
      const mo = new MutationObserver(() => {
        if (sw.t0 === null || sw.t1 !== null || !ok()) return;
        mo.disconnect();
        requestAnimationFrame(() => {
          sw.t1 = performance.now();
        });
      });
      mo.observe(document.body, { subtree: true, childList: true, attributes: true });
    },
    [expectId, expectPanes] as const,
  );
  await page.keyboard.press(key);
  await page.waitForFunction(
    () => (window as unknown as { __sw: { t1: number | null } }).__sw.t1 !== null,
    undefined,
    { timeout: 5_000 },
  );
  return page.evaluate(() => {
    const sw = (window as unknown as { __sw: { t0: number; t1: number } }).__sw;
    return sw.t1 - sw.t0;
  });
}

export function stats(ms: number[]): { n: number; max: number; p95: number; mean: number } {
  const s = [...ms].sort((a, b) => a - b);
  const r = (x: number) => Math.round(x * 10) / 10;
  return {
    n: s.length,
    max: r(s[s.length - 1]!),
    p95: r(s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]!),
    mean: r(s.reduce((a, b) => a + b, 0) / s.length),
  };
}

/** `extra` is recorded, never asserted (for example first_after_reload_ms). */
export function writeTiming(
  name: string,
  samples: Switch[],
  extra: Record<string, number> = {},
): void {
  writeFileSync(
    shot(name),
    JSON.stringify({ ...stats(samples.map((s) => s.ms)), ...extra, samples }, null, 2),
  );
}
