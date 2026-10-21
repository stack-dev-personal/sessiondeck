import { expect, test } from "@playwright/test";
import {
  LIVE,
  card,
  configureHub,
  ingest,
  newSessionId,
  startEnv,
  waitConnected,
} from "./live-helpers";
import { shot } from "./helpers";

test.skip(LIVE.hubUrl === "", "live spec: set SD_E2E_HUB_URL (see playwright.config.ts)");

/**
 * R3.1: a live session is on the board within 1 s of its SessionStart reaching the hub. The clock
 * starts when the POST /ingest response arrives (the hub has committed and broadcast by then)
 * and stops when the card is visible in the browser.
 */
test("R3.1 a SessionStart posted to the hub shows as a card within 1 s", async ({ page }) => {
  await configureHub(page);
  await page.goto("/board");
  await waitConnected(page);

  // The hub may already hold sessions: assert on this spec's own session ids only.
  const ids: string[] = [];
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const id = newSessionId();
    ids.push(id);
    const t0 = performance.now();
    await ingest([startEnv(id)]);
    await card(page, id).waitFor({ state: "visible", timeout: 5_000 });
    samples.push(Math.round(performance.now() - t0));
  }
  console.log(`R3.1 latency ms (POST sent to card visible), 5 samples: ${samples.join(", ")}`);
  console.log(`R3.1 max ${Math.max(...samples)} ms`);
  expect(Math.max(...samples)).toBeLessThan(1000);
  for (const id of ids) {
    await expect(card(page, id)).toBeVisible();
    await expect(card(page, id)).toHaveAttribute("data-state", /.+/);
  }
  await page.screenshot({ path: shot("R3.1.png") });
});
