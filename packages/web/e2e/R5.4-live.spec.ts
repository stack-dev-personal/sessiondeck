import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { shot } from "./helpers";
import {
  LIVE,
  card,
  configureHub,
  hookEnvelope,
  hubJson,
  ingest,
  newSessionId,
  startEnv,
  waitConnected,
} from "./live-helpers";

test.skip(LIVE.hubUrl === "", "live spec: set SD_E2E_HUB_URL (see playwright.config.ts)");

/**
 * R5.4 against a real hub through real CORS (no request interception): sessions are ingested, then
 * the palette flow runs with the keyboard only (page.keyboard / locator.press / page.goto; no
 * mouse API) against the hub's /search. Records the hub's took_ms and the browser's round trip
 * (request dispatch to results committed, from the User Timing measure the palette writes).
 */
const palette = (page: Page) => page.getByTestId("command-palette");
const optionsOf = (page: Page) => palette(page).getByRole("option");

interface Sample {
  q: string;
  tookMs: number;
  roundTripMs: number;
  results: number;
}
const samples: Sample[] = [];

async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press("Control+k");
  await expect(palette(page)).toBeVisible();
  await expect(palette(page).getByRole("combobox")).toBeFocused();
}

async function search(page: Page, q: string): Promise<Sample> {
  await page.keyboard.type(q);
  await expect(palette(page)).toHaveAttribute("data-results-for", q, { timeout: 10_000 });
  await expect(palette(page)).toHaveAttribute("data-status", "ready");
  await expect
    .poll(() =>
      page.evaluate(
        (query) =>
          performance
            .getEntriesByName("sd-palette-search")
            .some((m) => (m as PerformanceMeasure).detail?.q === query),
        q,
      ),
    )
    .toBe(true);
  const s = await page.evaluate((query) => {
    const hits = performance
      .getEntriesByName("sd-palette-search")
      .filter((m) => (m as PerformanceMeasure).detail?.q === query);
    const m = hits[hits.length - 1] as PerformanceMeasure;
    return {
      q: query,
      tookMs: m.detail.tookMs as number,
      roundTripMs: m.duration,
      results: m.detail.results as number,
    };
  }, q);
  samples.push(s);
  return s;
}

/** ArrowDown until the active option is of `kind`; returns how many presses it took. */
async function arrowTo(page: Page, kind: string): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const active = await palette(page).getByRole("combobox").getAttribute("aria-activedescendant");
    if ((await palette(page).locator(`[id="${active}"]`).getAttribute("data-kind")) === kind)
      return;
    await page.keyboard.press("ArrowDown");
  }
  throw new Error(`no ${kind} option reachable`);
}

async function patchPhase(id: string, phase: string): Promise<void> {
  const res = await fetch(`${LIVE.directUrl}/sessions/${id}/phase`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${LIVE.token}` },
    body: JSON.stringify({ phase }),
  });
  if (!res.ok) throw new Error(`PATCH phase: ${res.status}`);
}

test("R5.4 live: palette search through the real hub, keyboard only", async ({ page }) => {
  const r = Math.random().toString(36).slice(2, 8);
  const quokka = `quokka${r}`;
  const marmoset = `marmoset${r}`;
  const phase = `Sprint${r}`;
  const id = newSessionId();
  const other = newSessionId();
  await ingest([
    hookEnvelope(id, "SessionStart", "SessionStart/01-startup.json", {
      cwd: `/home/e2e/${quokka}`,
    }),
    hookEnvelope(id, "UserPromptSubmit", "UserPromptSubmit/01-sample.json", {
      cwd: `/home/e2e/${quokka}`,
      prompt: `Port the ${marmoset} parser to the new queue`,
    }),
  ]);
  await ingest([startEnv(other)]);
  await patchPhase(id, phase);
  const project = (await hubJson<{ project_id: string }>(`/sessions/${id}`)).project_id;

  await configureHub(page);
  await page.goto("/board");
  await waitConnected(page);
  await card(page, id).waitFor({ state: "visible", timeout: 10_000 });

  // 1. A session by its prompt text: Enter opens the drawer (the board holds it).
  await page.keyboard.press("j");
  await openPalette(page);
  await expect(palette(page)).toHaveAttribute("data-results-for", "");
  const first = await search(page, marmoset);
  expect(first.results).toBeGreaterThanOrEqual(1);
  const hit = optionsOf(page).first();
  await expect(hit).toHaveAttribute("data-kind", "session");
  await expect(hit).toHaveAttribute("data-result-id", id);
  await expect(hit).toContainText(marmoset); // hub snippet, rendered as text
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("detail-drawer")).toHaveAttribute("data-session-id", id);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("detail-drawer")).toHaveCount(0);

  // 2. The project by name: ArrowDown to the project group, Enter goes to its view.
  await openPalette(page);
  await search(page, quokka);
  await arrowTo(page, "project");
  await page.screenshot({ path: shot("R5.4-live.png") });
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/projects/${project}$`));
  await expect(page.getByTestId("project-name")).toContainText(quokka);

  // 3. The phase label: Enter lands on the filtered list; j and Enter open the session from there.
  await openPalette(page);
  await search(page, phase);
  await arrowTo(page, "phase");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    new RegExp(`/sessions\\?project=${project}&phase=${encodeURIComponent(phase)}$`),
  );
  const rows = page.getByTestId("session-list-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-session-id", id);
  await page.keyboard.press("j");
  await expect(rows.first()).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("detail-drawer")).toHaveAttribute("data-session-id", id);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("detail-drawer")).toHaveCount(0);

  // 4. Warm latency: typed queries against the live index (the first request above paid CORS preflight).
  for (const q of [marmoset, quokka, phase, `pars${r}`, "queue", "port"]) {
    await openPalette(page);
    await search(page, q);
    await page.keyboard.press("Escape");
    await expect(palette(page)).toHaveCount(0);
  }
  const warm = samples.slice(3);
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const summary = {
    note: "tookMs is the hub's own time; roundTripMs is request dispatch to results committed in the browser (excludes the 80 ms debounce)",
    samples,
    hubTookMsMax: Math.max(...samples.map((s) => s.tookMs)),
    warmRoundTripMsMedian: median(warm.map((s) => s.roundTripMs)),
    warmRoundTripMsMax: Math.max(...warm.map((s) => s.roundTripMs)),
  };
  console.log(`R5.4 live latency: ${JSON.stringify(summary)}`);
  writeFileSync(shot("R5.4-live-latency.json"), JSON.stringify(summary, null, 2));
  expect(summary.hubTookMsMax).toBeLessThan(100);
  expect(summary.warmRoundTripMsMedian).toBeLessThan(100);
});
