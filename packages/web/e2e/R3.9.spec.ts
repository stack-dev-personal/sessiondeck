import { expect, test } from "@playwright/test";
import {
  LIVE,
  card,
  configureHub,
  endEnv,
  ingest,
  newSessionId,
  promptEnv,
  startEnv,
  stopEnv,
  waitConnected,
} from "./live-helpers";
import { shot } from "./helpers";

test.skip(
  LIVE.hubUrl === "" || LIVE.gateUrl === "",
  "live spec: set SD_E2E_HUB_URL and SD_E2E_GATE_URL (see playwright.config.ts)",
);

const gate = async (action: "down" | "up") => {
  const r = await fetch(`${LIVE.gateUrl}/${action}`);
  if (!r.ok) throw new Error(`gate ${action}: ${r.status}`);
};

/**
 * R3.9: the WS link is cut at the gate (the hub keeps running and accepting ingest). The banner
 * appears, the board does not move, sessions change on the hub while the browser is cut off, and
 * after the gate opens the client reconnects and the initial message replaces the stale view.
 */
test("R3.9 disconnect shows a banner, reconnect resyncs, no stale working card", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await gate("up");
  // R3.10: display hysteresis holds a just-idled session as working for the grace period. This
  // spec proves the resync brings hub truth, so the grace is 0 (the Settings key, before load).
  await configureHub(page, { idleGraceSec: 0 });
  await page.goto("/board");
  await waitConnected(page);

  const a = newSessionId();
  const b = newSessionId();
  await ingest([startEnv(a), promptEnv(a), startEnv(b), promptEnv(b)]);
  await expect(card(page, a)).toHaveAttribute("data-state", "working");
  await expect(card(page, b)).toHaveAttribute("data-state", "working");
  const before = await card(page, a).boundingBox();
  const banner = page.getByTestId("connection-banner");
  await expect(banner).toHaveText("");

  await gate("down");
  await expect(banner).toContainText(/Disconnected, reconnecting|Reconnecting/, {
    timeout: 15_000,
  });
  await expect(page.getByTestId("connection")).toContainText("disconnected");
  await expect(banner).toContainText("✖");
  await page.screenshot({ path: shot("R3.9-banner.png") });
  // The banner is an overlay: the card did not move or resize.
  expect(await card(page, a).boundingBox()).toEqual(before);
  // Stale on purpose while cut off: the browser has not heard about the changes below.
  await expect(card(page, a)).toHaveAttribute("data-state", "working");

  await ingest([stopEnv(a), endEnv(b)]);
  await page.waitForTimeout(1_500);
  await expect(card(page, a)).toHaveAttribute("data-state", "working");

  await gate("up");
  await expect(page.getByTestId("connection")).toHaveText("● connected", { timeout: 30_000 });
  await expect(banner).toHaveText("");
  await expect(card(page, a)).toHaveAttribute("data-state", "idle");
  await expect(card(page, b)).toHaveAttribute("data-state", "ended");
  await expect(page.locator('[data-testid="session-card"][data-state="working"]')).toHaveCount(0);
  // Order may change with the hub's initial; the card geometry does not.
  const after = await card(page, a).boundingBox();
  expect(after?.width).toBeCloseTo(before!.width, 0);
  expect(after?.height).toBe(before?.height);
  await page.screenshot({ path: shot("R3.9.png") });
});
