import { expect, test } from "@playwright/test";
import { STATES, fullShot, gotoDevCards, openSettledBoard, setTheme, settledMix } from "./helpers";

test("R3.2 every state shows glyph and label; null card has the same geometry", async ({
  page,
}) => {
  await setTheme(page, "dark");
  await gotoDevCards(page);

  for (const [state, glyph, label] of STATES) {
    for (const id of [`specimen-state-${state}`, `specimen-state-${state}-compact`]) {
      const el = page.getByTestId(id);
      await expect(el, id).toContainText(glyph);
      await expect(el, id).toContainText(label);
    }
  }

  const card = (id: string) => page.getByTestId(`specimen-${id}`).getByTestId("session-card");
  const nul = card("all-null");
  const full = card("populated");
  await expect(nul).toContainText("n/a");

  const nb = (await nul.boundingBox())!;
  const fb = (await full.boundingBox())!;
  expect(nb.height).toBe(fb.height);
  expect(nb.width).toBe(fb.width);

  for (let row = 1; row <= 6; row++) {
    const a = (await nul.locator(`[data-row="${row}"]`).boundingBox())!;
    const b = (await full.locator(`[data-row="${row}"]`).boundingBox())!;
    expect(a.height, `row ${row} height`).toBe(b.height);
  }
  for (const kind of ["context", "five_hour", "seven_day"]) {
    const a = (await nul.locator(`[data-meter="${kind}"]`).boundingBox())!;
    const b = (await full.locator(`[data-meter="${kind}"]`).boundingBox())!;
    expect(a.width, `${kind} meter width`).toBe(b.width);
    const ab = (await nul.locator(`[data-meter="${kind}"] [data-slot="bar"]`).boundingBox())!;
    const bb = (await full.locator(`[data-meter="${kind}"] [data-slot="bar"]`).boundingBox())!;
    expect(ab.width, `${kind} bar width`).toBe(bb.width);
  }

  // Stale window renders n/a for 5h; 200k+ tag; 12 subagents show +n.
  await expect(
    page.getByTestId("specimen-stale-window").locator('[data-meter="five_hour"]'),
  ).toContainText("n/a");
  await expect(page.getByTestId("specimen-over-200k")).toContainText("200k+");
  await expect(
    page.getByTestId("specimen-subagents-12").locator('[data-slot="dots-more"]'),
  ).toHaveText(/\+\d+/);
  // Every specimen card has the same height (long names truncate, never grow the card).
  const heights = await page
    .locator('[data-testid="session-card"][data-density="full"]')
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  expect(new Set(heights).size).toBe(1);

  await fullShot(page, "R3.2.png", { baseline: true });
});

test("R3.2 /dev/cards at 2560x1440 keeps the card geometry", async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await setTheme(page, "dark");
  await gotoDevCards(page);
  const heights = await page
    .locator('[data-testid="session-card"][data-density="full"]')
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  expect(new Set(heights).size).toBe(1);
  await fullShot(page, "R3.2-2560.png", { baseline: true });
});

test("R3.2 settled board: numbers, subagents, tasks and the state mix", async ({ page }) => {
  await setTheme(page, "dark");
  await openSettledBoard(page);
  const mix = await settledMix(page);
  console.log(`R3.2 settled board: ${JSON.stringify(mix)}`);
  expect(mix.withContext).toBeGreaterThanOrEqual(6);
  expect(mix.withLimits).toBeGreaterThanOrEqual(6);
  expect(mix.withDots).toBeGreaterThanOrEqual(2);
  expect(mix.withTasks).toBeGreaterThanOrEqual(2);
  expect(new Set(mix.names).size).toBe(mix.names.length);
  expect(mix.withBranch).toBeGreaterThanOrEqual(6);
  expect(Object.keys(mix.states).sort()).toEqual(STATES.map(([st]) => st).sort());
  const bad = await page.getByTestId("session-card").evaluateAll((cards) => {
    const out: string[] = [];
    cards.forEach((card, i) => {
      const row = card.querySelector('[data-row="1"]')!;
      for (const el of row.querySelectorAll("*")) {
        const h = el as HTMLElement;
        if (h.scrollWidth > h.clientWidth && getComputedStyle(h).textOverflow !== "ellipsis") {
          // Only leaf-text boxes must carry the ellipsis; containers clip their truncating children.
          if (h.children.length === 0) out.push(`card ${i}: ${h.textContent}`);
        }
      }
      const det = row.querySelector('[data-part="detail"]') as HTMLElement | null;
      if (det && det.textContent) {
        const ch = parseFloat(getComputedStyle(det).fontSize) * 0.5;
        if (det.clientWidth < ch * 6)
          out.push(`card ${i}: detail collapsed (${det.clientWidth}px)`);
      }
      const a =
        row.querySelector('[data-part="detail"]') ?? row.querySelector('[data-slot="state"]');
      const b = row.querySelector('[data-slot="where"]');
      if (a && b) {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        if (ra.right > rb.left && ra.left < rb.right) out.push(`card ${i}: overlap`);
      }
    });
    return out;
  });
  expect(bad).toEqual([]);
  await fullShot(page, "R3.2-board.png", { baseline: true });
});
