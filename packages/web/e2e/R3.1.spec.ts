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
  await expect(page.getByTestId("session-card")).toHaveCount(0);

  const samples: number[] = [];
  let last = "";
  for (let i = 0; i < 5; i++) {
    const id = newSessionId();
    last = id;
    const t0 = performance.now();
    await ingest([startEnv(id)]);
    await card(page, id).waitFor({ state: "visible", timeout: 5_000 });
    samples.push(Math.round(performance.now() - t0));
  }
  console.log(`R3.1 latency ms (POST sent to card visible), 5 samples: ${samples.join(", ")}`);
  console.log(`R3.1 max ${Math.max(...samples)} ms`);
  expect(Math.max(...samples)).toBeLessThan(1000);
  await expect(page.getByTestId("session-card")).toHaveCount(5);
  await expect(card(page, last)).toHaveAttribute("data-state", /.+/);
  await page.screenshot({ path: shot("R3.1.png") });
});
