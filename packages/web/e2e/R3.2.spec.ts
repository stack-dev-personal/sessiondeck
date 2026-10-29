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
  for (const kind of ["context"]) {
    const a = (await nul.locator(`[data-meter="${kind}"]`).boundingBox())!;
    const b = (await full.locator(`[data-meter="${kind}"]`).boundingBox())!;
    expect(a.width, `${kind} meter width`).toBe(b.width);
    const ab = (await nul.locator(`[data-meter="${kind}"] [data-slot="bar"]`).boundingBox())!;
    const bb = (await full.locator(`[data-meter="${kind}"] [data-slot="bar"]`).boundingBox())!;
    expect(ab.width, `${kind} bar width`).toBe(bb.width);
  }

  // 200k+ tag; 12 subagents show +n. Cards carry no 5h or 7d meter (R3.12).
  await expect(page.locator('[data-testid="session-card"] [data-meter="five_hour"]')).toHaveCount(
    0,
  );
  await expect(page.locator('[data-testid="session-card"] [data-meter="seven_day"]')).toHaveCount(
    0,
  );
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
  expect(mix.withUsageMeters).toBe(0); // R3.12: account usage is in the widget
  expect(mix.withDots).toBeGreaterThanOrEqual(2);
  expect(mix.withTasks).toBeGreaterThanOrEqual(2);
  expect(new Set(mix.names).size).toBe(mix.names.length);
  expect(mix.withBranch).toBeGreaterThanOrEqual(6);
  // R3.10: with the clock frozen the idle grace never lapses, so a session that just went idle is
  // still shown as working. The idle state itself is covered by the specimens above.
  expect(Object.keys(mix.states).sort()).toEqual(
    STATES.map(([st]) => st)
      .filter((st) => st !== "idle")
      .sort(),
  );
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

test("R3.2 compact rows: every nullable field null to longest value moves nothing and never clips at 320-1280 px", async ({
  page,
}) => {
  await page.addInitScript(() => window.localStorage.setItem("sd.compact", "1"));
  await openSettledBoard(page);
  type Store = {
    getState: () => { sessions: Record<string, Record<string, unknown>> };
    setState: (p: unknown) => void;
  };
  const patch = (patchObj: Record<string, unknown>, sid?: string) =>
    page.evaluate(
      ({ arg, want }) => {
        const b = (window as unknown as { __sd: { board: Store } }).__sd.board;
        const s = b.getState().sessions;
        const id =
          want ??
          document.querySelector<HTMLElement>('[data-testid="session-card"]')!.dataset[
            "sessionId"
          ]!;
        b.setState({ sessions: { ...s, [id]: { ...s[id], ...arg } } });
        return id;
      },
      { arg: patchObj, want: sid },
    );
  const raf = () =>
    page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const boxes = (id: string) =>
    page.evaluate((sid) => {
      const card = document.querySelector<HTMLElement>(`[data-session-id="${sid}"]`)!;
      // Relative to the card: a state change legitimately re-sorts the card on the board.
      const c0 = card.getBoundingClientRect();
      const rect = (e: Element) => {
        const r = e.getBoundingClientRect();
        return [r.x - c0.x, r.y - c0.y, r.width, r.height].map((n) => Math.round(n * 10) / 10);
      };
      return {
        card: rect(card),
        density: card.dataset["density"],
        items: Array.from(card.querySelectorAll("[data-slot], [data-meter]"))
          // The text inside the fixed tasks slot is right-aligned, so only the slot is measured.
          .filter((e) => !e.closest('[data-slot="tasks"]'))
          .map((e) => ({
            k: (e as HTMLElement).dataset["slot"] ?? (e as HTMLElement).dataset["meter"],
            r: rect(e),
          })),
      };
    }, id);
  const future = Date.now() + 3_600_000;
  const empty = {
    state: "starting",
    session_name: null,
    context: { used_pct: null, window: null, input: null, output: null },
    rate_limits: { five_hour: null, seven_day: null, captured_at: null },
    tasks: { total: 0, completed: 0, last_subject: null },
    subagents: [],
  };
  const full = {
    state: "waiting_permission",
    session_name: "a very long session name that must truncate and never wrap the row",
    context: { used_pct: 100, window: 1_000_000, input: 1, output: 1 },
    rate_limits: {
      five_hour: { used_pct: 100, resets_at: future },
      seven_day: { used_pct: 100, resets_at: future },
      captured_at: future,
    },
    tasks: { total: 100, completed: 100, last_subject: "x" },
    subagents: Array.from({ length: 12 }, (_, i) => ({
      agent_id: `agent-${i}`,
      agent_type: "general-purpose",
      started_at: future - 60_000,
      ended_at: null,
      tokens: null,
      context_window: null,
      model: null,
    })),
  };
  // No slot may pass the card content box (the card clips silently) and the name keeps room.
  const noClip = (id: string) =>
    page.evaluate((sid) => {
      const card = document.querySelector<HTMLElement>(`[data-session-id="${sid}"]`)!;
      const cs = getComputedStyle(card);
      const c = card.getBoundingClientRect();
      const right = c.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight) + 0.5;
      const over: string[] = [];
      for (const e of Array.from(card.querySelectorAll<HTMLElement>("[data-slot], [data-meter]"))) {
        if (e.closest('[data-slot="tasks"]') && e.dataset["slot"] !== "tasks") continue;
        const r = e.getBoundingClientRect();
        if (r.right > right)
          over.push(`${e.dataset["slot"] ?? e.dataset["meter"]}:${r.right}>${right}`);
      }
      const name = card.querySelector<HTMLElement>('[data-slot="name"]')!;
      return { over, nameW: name.getBoundingClientRect().width };
    }, id);
  for (const w of [320, 360, 400, 440, 480, 520, 560, 600, 640, 800, 1280]) {
    await page.setViewportSize({ width: w, height: 800 });
    const id = await patch(empty);
    await raf();
    const before = await boxes(id);
    expect(before.density).toBe("compact");
    await patch(full, id);
    await raf();
    const after = await boxes(id);
    expect(after.card, `${w}px card box`).toEqual(before.card);
    expect(after.items, `${w}px item boxes`).toEqual(before.items);
    const m = await noClip(id);
    expect(m.over, `${w}px slots past content box`).toEqual([]);
    expect(m.nameW, `${w}px name width`).toBeGreaterThan(0);
  }
});
