import { expect, test, type Page } from "@playwright/test";
import { freezeClock, shot, waitForReplayDone } from "./helpers";
import { LIVE, configureHub, waitConnected } from "./live-helpers";
import {
  FakeHub,
  paneCount,
  pickPreset,
  pressAndMeasure,
  saveVia,
  stats,
  writeTiming,
  type HubRow,
  type Switch,
} from "./saved-helpers";

/**
 * R6.3 (web half): save three layouts to slots 1-3, reload, press 1/2/3, each switch shows the
 * right layout in under 100 ms (measured in the page, keydown to the frame after the panes exist),
 * and the hub holds the rows. Two backends: a fake hub through page.route (mock build), and the real
 * hub (live build, SD_E2E_HUB_URL set, scripts/e2e-live.sh).
 */
const SWITCH_BUDGET_MS = 100;
const PRESETS = [
  ["Pair", "pair"],
  ["Quad", "quad"],
  ["Focus", "focus"],
] as const;

async function saveThree(page: Page, openLayout: () => Promise<void>): Promise<void> {
  await openLayout();
  for (const [i, [label, id]] of PRESETS.entries()) {
    await pickPreset(page, new RegExp(label), id);
    await saveVia(
      page,
      `Layout ${i + 1} ${label}`,
      i + 1,
      i === 0 ? { screenshot: "R6.3-save-dialog.png" } : {},
    );
    await expect(page.getByTestId("layout-notice")).toContainText(
      `Saved "Layout ${i + 1} ${label}" in slot ${i + 1}`,
    );
  }
}

/**
 * The very first switch after a reload pays one-off costs (lazy chunks, JIT, first layout of the
 * panes). It is pressed on a slot that the measured run does not start with, so every measured
 * switch is a real switch between two layouts. Its time is returned to be recorded, not asserted.
 */
async function firstSwitch(page: Page, key: string, row: HubRow): Promise<number> {
  return pressAndMeasure(page, key, row.id, paneCount(row.spec));
}

async function switchesAfterReload(page: Page, rows: HubRow[], tag: string): Promise<void> {
  const bySlot = (n: number) => rows.find((r) => r.hotkey === n)!;
  const samples: Switch[] = [];
  const order = [1, 2, 3, 3, 1, 2, 1, 3, 2, 2, 3, 1, 1, 2, 3, 2, 1, 3];
  let shots = 0;
  // First press after the reload is slot 2 (recorded; the layout in force is slot 3's, so it is a real
  // switch); the order below starts with slot 1.
  const firstAfterReload = await firstSwitch(page, "2", bySlot(2));
  let prev = bySlot(2).id;
  for (const n of order) {
    const row = bySlot(n);
    if (row.id === prev) continue; // pressing the active layout's key changes nothing to measure
    const ms = await pressAndMeasure(page, String(n), row.id, paneCount(row.spec));
    prev = row.id;
    samples.push({ key: String(n), ms });
    await expect(page.getByTestId("layout")).toHaveAttribute("data-layout-id", row.id);
    await expect(page.getByTestId("layout-notice")).toContainText(`Layout ${n}: ${row.name}`);
    // The toolbar names the saved layout, never its id.
    await expect(page.getByTestId("layout-menu-button")).toHaveText(`Layout: ${row.name} (l)`);
    await expect(page.getByTestId("layout-menu-button")).not.toContainText(row.id);
    if (shots < 3) await page.screenshot({ path: shot(`R6.3-saved-${++shots}${tag}.png`) });
  }
  writeTiming(`R6.3-timing${tag}.json`, samples, { first_after_reload_ms: firstAfterReload });
  const st = stats(samples.map((s) => s.ms));
  console.log(
    `R6.3 switch ms${tag}: n=${st.n} max=${st.max} p95=${st.p95} mean=${st.mean} first_after_reload=${firstAfterReload}`,
  );
  expect(samples.length).toBeGreaterThanOrEqual(10);
  for (const s of samples) expect(s.ms, `key ${s.key}`).toBeLessThan(SWITCH_BUDGET_MS);
}

test.describe("R6.3 fake hub", () => {
  test.skip(LIVE.hubUrl !== "", "mock build only; the live describe runs against the real hub");

  test("R6.3 save to slots 1-3, reload, hotkeys switch in under 100 ms, rows live in the hub", async ({
    page,
  }) => {
    const hub = new FakeHub();
    await hub.install(page);
    await freezeClock(page);
    await saveThree(page, async () => {
      await page.goto("/layout?replay=fast");
      await waitForReplayDone(page);
    });

    // Persisted in the hub, not just in the page.
    expect(hub.rows.map((r) => r.hotkey).sort()).toEqual([1, 2, 3]);
    expect(hub.rows.map((r) => r.name).sort()).toEqual(
      PRESETS.map(([l], i) => `Layout ${i + 1} ${l}`).sort(),
    );
    expect(hub.rows.every((r) => r.host === null)).toBe(true);

    await page.reload();
    await waitForReplayDone(page);
    // The hub is the source of truth after a reload: its GET ran again.
    await expect
      .poll(() => hub.calls.filter((c) => c === "GET /layouts").length)
      .toBeGreaterThanOrEqual(2);
    await switchesAfterReload(page, hub.rows, "");

    // A key in an empty slot changes nothing and says so; typing a digit in the dialog name does not switch.
    const before = await page.getByTestId("layout").getAttribute("data-layout-id");
    await page.keyboard.press("7");
    await expect(page.getByTestId("layout-notice")).toContainText("No layout in slot 7.");
    await expect(page.getByTestId("layout")).toHaveAttribute("data-layout-id", before!);
    await page.keyboard.press("s");
    await page.getByRole("textbox", { name: "Name" }).fill("1");
    await expect(page.getByTestId("layout")).toHaveAttribute("data-layout-id", before!);
    await page.keyboard.press("Escape");
  });

  test("R6.3 cached layouts switch while the hub is down; a write error is shown and nothing is stored", async ({
    page,
  }) => {
    const hub = new FakeHub();
    await hub.install(page);
    await freezeClock(page);
    await page.goto("/layout?replay=fast");
    await waitForReplayDone(page);
    await pickPreset(page, /Pair/, "pair");
    await saveVia(page, "Cached pair", 5);
    await pickPreset(page, /Quad/, "quad");
    await saveVia(page, "Cached quad", 4); // the layout in force at reload

    hub.failNext = 429;
    await page.keyboard.press("s");
    await page.getByRole("textbox", { name: "Name" }).fill("Burst");
    await page.getByRole("textbox", { name: "Name" }).press("Enter");
    await expect(page.getByTestId("save-error")).toContainText("Too many layout changes");
    await page.keyboard.press("Escape");
    expect(hub.rows).toHaveLength(2);

    // Hub gone: the reload cannot reach it, yet the key still works from the cache.
    await page.route(`${hub.origin}/**`, (r) => r.abort("connectionrefused"));
    await page.reload();
    await waitForReplayDone(page);
    // First press (slot 5, recorded only), then slot 4 is a real switch between two layouts.
    const pair = hub.rows.find((r) => r.hotkey === 5)!;
    const quad = hub.rows.find((r) => r.hotkey === 4)!;
    const first = await firstSwitch(page, "5", pair);
    const ms = await pressAndMeasure(page, "4", quad.id, paneCount(quad.spec));
    writeTiming("R6.3-timing-hub-down.json", [{ key: "4", ms }], { first_after_reload_ms: first });
    expect(ms).toBeLessThan(SWITCH_BUDGET_MS);
    await expect(page.getByRole("button", { name: /Saved: 2 \(cached\)/ })).toBeVisible();
  });

  test("R6.3 save dialog and manage dialog are keyboard operable", async ({ page }) => {
    const hub = new FakeHub();
    await hub.install(page);
    await freezeClock(page);
    await page.goto("/layout?replay=fast");
    await waitForReplayDone(page);
    await page.keyboard.press("s");
    await page.getByRole("textbox", { name: "Name" }).fill("Keys");
    // Name, slot, then Cancel: the pin box is disabled with no Viewer host and is skipped.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: /Cancel/ })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("save-dialog")).toHaveCount(0);
    expect(hub.rows).toHaveLength(0);
    await saveVia(page, "Keys", 1);
    await page.keyboard.press("m");
    await expect(page.getByTestId("saved-row")).toHaveCount(1);
    await page.screenshot({ path: shot("R6.3-manage-dialog.png") });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("manage-dialog")).toHaveCount(0);
  });
});

test.describe("R6.3 Viewer host setting", () => {
  test.skip(LIVE.hubUrl !== "", "mock build only");

  test("R6.3 Viewer host: default none, choose a known host, saved, the dialog pins to it", async ({
    page,
  }) => {
    const hub = new FakeHub();
    await hub.install(page);
    await freezeClock(page);
    await page.goto("/layout?replay=fast");
    await waitForReplayDone(page);
    // None: the pin box is disabled and says where to set it.
    await page.keyboard.press("s");
    await expect(
      page.getByRole("checkbox", { name: /Pin to the Viewer host \(none set/ }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");

    await page.getByRole("link", { name: /settings/i }).click();
    const sel = page.getByRole("combobox", { name: "Viewer host" });
    await expect(sel).toHaveValue("");
    const host = (await sel.locator("option").nth(1).getAttribute("value"))!;
    await sel.selectOption(host);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("settings-saved")).toContainText("Saved");
    await page.screenshot({ path: shot("R6.3-viewer-host.png") });

    await page.getByRole("link", { name: /layout/i }).click();
    await page.keyboard.press("s");
    const pin = page.getByRole("checkbox", { name: new RegExp(`Pin to Viewer host ${host}`) });
    await expect(pin).toBeEnabled();
    await pin.check();
    await page.getByRole("textbox", { name: "Name" }).fill("Pinned");
    await page.getByRole("textbox", { name: "Name" }).press("Enter");
    await page.getByTestId("save-dialog").waitFor({ state: "detached" });
    expect(hub.rows[0]?.host).toBe(host);
  });
});

test.describe("R6.3 real hub", () => {
  test.skip(
    LIVE.hubUrl === "",
    "live spec: set SD_E2E_HUB_URL (scripts/e2e-live.sh, SD_E2E_ARGS=R6.3)",
  );

  const get = async (): Promise<HubRow[]> => {
    const res = await fetch(`${LIVE.directUrl}/layouts`, {
      headers: { authorization: `Bearer ${LIVE.token}` },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { layouts: HubRow[] }).layouts;
  };
  const clean = async () => {
    for (const r of await get())
      await fetch(`${LIVE.directUrl}/layouts/${r.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${LIVE.token}` },
      });
  };

  test("R6.3 live: save to slots 1-3, reload, hotkeys switch in under 100 ms, rows live in the hub", async ({
    page,
  }) => {
    await clean();
    await configureHub(page);
    // No relay: the browser (origin localhost:5174) makes the real cross-origin call, preflight
    // included. The hub answers with its CORS allowlist (HUB_ALLOWED_ORIGINS in scripts/e2e-live.sh).
    const hubOrigin = new URL(LIVE.hubUrl).origin; // the URL class lowercases the host
    const allowOrigins: (string | undefined)[] = [];
    page.on("response", (r) => {
      if (r.request().method() === "PUT" && r.url().startsWith(`${hubOrigin}/layouts/`))
        allowOrigins.push(r.headers()["access-control-allow-origin"]);
    });
    await saveThree(page, async () => {
      await page.goto("/layout");
      await waitConnected(page);
    });
    // Three real cross-origin PUTs, each answered with the exact origin of the page (not *).
    expect(allowOrigins).toEqual(Array(3).fill(new URL(page.url()).origin));
    expect(allowOrigins[0]).not.toBe(new URL(LIVE.hubUrl).origin);
    const rows = await get();
    expect(rows.map((r) => r.hotkey).sort()).toEqual([1, 2, 3]);
    await page.reload();
    await waitConnected(page);
    await switchesAfterReload(page, rows, "-live");
    expect((await get()).map((r) => r.id).sort()).toEqual(rows.map((r) => r.id).sort());
    await clean();
  });
});
