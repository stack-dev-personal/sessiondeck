import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  axeViolations,
  expectAllReadable,
  measureAllText,
  measureControlBorders,
  setConnection,
  tokenRatio,
} from "./a11y-helpers";
import { fullShot, navigate, openSettledBoard, setTheme, shot } from "./helpers";

// R3.7 re-verified over what S6 added: connection banner (all statuses), header status, board
// toolbar and hidden-attention hint, attention accent and glow, Settings, ErrorBoundary.
// Mock build; stores are driven through window.__sd (src/main.tsx, absent from the nomock bundle).

async function filterToHiddenAttention(page: Page): Promise<void> {
  const options = await page
    .locator("#board-filter-project option")
    .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ""));
  for (const v of options) {
    await page.locator("#board-filter-project").selectOption(v);
    if (await page.getByTestId("board-hidden-attention").isVisible()) return;
  }
  throw new Error("no project filter hides an attention session");
}

for (const theme of ["dark", "light"] as const) {
  test(`R3.7 live ${theme}: banner statuses, toolbar, hint, header, attention`, async ({
    page,
  }) => {
    await setTheme(page, theme);
    await openSettledBoard(page);
    const bad: string[] = [];

    // Attention cards are on the board; stripe and ring are non-text UI (1.4.11, needs 3:1).
    expect(await page.locator('[data-attention="true"]').count()).toBeGreaterThan(0);
    for (const bg of ["--surface-1", "--bg"]) {
      expect(
        await tokenRatio(page, "--accent-attention", bg),
        `stripe on ${bg}`,
      ).toBeGreaterThanOrEqual(3);
      expect(await tokenRatio(page, "--accent", bg), `focus ring on ${bg}`).toBeGreaterThanOrEqual(
        3,
      );
    }
    expect(
      await tokenRatio(page, "--state-error", "--surface-2"),
      "banner border",
    ).toBeGreaterThanOrEqual(3);

    // Toolbar with an active filter plus the hidden-attention hint.
    await filterToHiddenAttention(page);
    await expect(page.getByTestId("board-hidden-attention")).toContainText("need attention");
    await expect(page.getByTestId("board-count")).toContainText("Showing");
    bad.push(...(await axeViolations(page, `${theme} board+toolbar+hint`)));
    expectAllReadable(await measureAllText(page), `${theme} toolbar+hint`);
    expect(await measureControlBorders(page), `${theme} board control boundaries`).toEqual([]);
    await fullShot(page, `R3.7-live-${theme}.png`);
    await page.locator("#board-filter-project").selectOption("");

    // Every banner status, each with the header text it pairs with.
    const statuses = [
      ["closed", 5000, "Disconnected, reconnecting in", "disconnected"],
      ["invalid", null, "Hub URL invalid", "hub URL invalid"],
      ["connecting", null, "Reconnecting", "connecting"],
      ["open", null, "", "connected"],
    ] as const;
    for (const [status, retry, banner, header] of statuses) {
      await setConnection(page, status, retry);
      const region = page.getByTestId("connection-banner");
      await expect(region).toHaveAttribute("role", "status");
      await expect(region).toHaveAttribute("aria-live", "polite");
      if (banner === "") await expect(region).toHaveText("");
      else await expect(region).toContainText(banner);
      await expect(page.getByTestId("connection")).toContainText(header);
      bad.push(...(await axeViolations(page, `${theme} connection=${status}`)));
      expectAllReadable(await measureAllText(page), `${theme} connection=${status}`);
      if (status === "closed" && theme === "dark") {
        await page.screenshot({ path: shot("R3.7-banner.png") });
      }
      if (status === "invalid" && theme === "light") {
        await page.screenshot({ path: shot("R3.7-banner-light.png") });
      }
    }
    expect(bad).toEqual([]);
  });

  test(`R3.7 live ${theme}: Settings (alerts, tones, mute, insecure URL) and saved status`, async ({
    page,
  }) => {
    await setTheme(page, theme);
    await openSettledBoard(page);
    await navigate(page, "/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await page.getByLabel("Hub URL").fill("http://hub.example.test:8787");
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("not encrypted");
    // Each toggle has an accessible name from its label; tones and notifications are opt-in.
    const boxes = page.getByRole("checkbox");
    await expect(boxes).toHaveCount(4);
    for (const box of await boxes.all()) await expect(box).not.toBeChecked();
    await page.getByLabel("Mute all tones").check();
    const saved = page.getByTestId("settings-saved");
    await expect(saved).toHaveCount(1);
    await expect(saved).toHaveText("");
    await expect(saved).toHaveAttribute("role", "status");
    expect(await axeViolations(page, `${theme} settings`)).toEqual([]);
    expectAllReadable(await measureAllText(page), `${theme} settings`);
    expect(await measureControlBorders(page), `${theme} settings control boundaries`).toEqual([]);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(saved).toHaveText(/Saved/);
    expect(await axeViolations(page, `${theme} settings saved`)).toEqual([]);
    expectAllReadable(await measureAllText(page), `${theme} settings saved`);
    await fullShot(page, `R3.7-settings-${theme}.png`);
  });

  test(`R3.7 live ${theme}: ErrorBoundary fallback`, async ({ page }) => {
    await setTheme(page, theme);
    await openSettledBoard(page);
    // A null session makes the board throw while rendering; the shell must stay.
    await page.evaluate(() => {
      const sd = (
        window as unknown as {
          __sd: {
            board: {
              getState: () => { sessions: Record<string, object> };
              setState: (p: unknown) => void;
            };
          };
        }
      ).__sd;
      const s = sd.board.getState().sessions;
      const first = Object.values(s)[0]!;
      sd.board.setState({
        sessions: { ...s, broken: { ...first, session_id: "broken", git: null } },
      });
    });
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Something failed");
    await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(await axeViolations(page, `${theme} error boundary`)).toEqual([]);
    expectAllReadable(await measureAllText(page), `${theme} error boundary`);
    expect(await measureControlBorders(page), `${theme} error boundary control boundaries`).toEqual(
      [],
    );
  });

  test(`R3.7 live ${theme}: detail drawer control boundaries`, async ({ page }) => {
    await setTheme(page, theme);
    await openSettledBoard(page);
    await page.locator('[data-testid="session-card"]').first().focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await page.getByRole("dialog").getByRole("button").count()).toBeGreaterThan(0);
    expect(await measureControlBorders(page), `${theme} drawer control boundaries`).toEqual([]);
  });
}

test("R3.7 live: keyboard walk, focus order after reorder, focus visible, shortcuts", async ({
  page,
}) => {
  await openSettledBoard(page);
  // Reorder: make the last card in DOM order a waiting one so it jumps to the front.
  const moved = await page.evaluate(() => {
    const sd = (
      window as unknown as {
        __sd: {
          board: {
            getState: () => { sessions: Record<string, { state: string }> };
            setState: (p: unknown) => void;
          };
        };
      }
    ).__sd;
    const cards = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="session-card"]'),
    );
    const last = cards[cards.length - 1]!;
    const id = last.dataset["sessionId"]!;
    const s = sd.board.getState().sessions;
    sd.board.setState({
      sessions: {
        ...s,
        [id]: { ...s[id], state: "waiting_permission", last_event_at: new Date().toISOString() },
      },
    });
    return id;
  });
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const order = await page
    .locator('[data-testid="session-card"]')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset["sessionId"]));
  expect(order[0] === moved || order.indexOf(moved) < order.length - 1).toBe(true);

  // Tab through the whole page; record order, rect and outline of every stop.
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const stops: {
    label: string;
    x: number;
    y: number;
    outline: string;
    w: number;
    card: boolean;
  }[] = [];
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const st = await page.evaluate(() => {
      const e = document.activeElement as HTMLElement;
      if (!e || e === document.body) return null;
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return {
        label:
          e.getAttribute("aria-label") ?? e.id ?? e.textContent?.trim().slice(0, 24) ?? e.tagName,
        x: r.x,
        y: r.y,
        outline: `${cs.outlineStyle} ${cs.outlineColor}`,
        w: parseFloat(cs.outlineWidth),
        card: e.dataset["testid"] === "session-card",
      };
    });
    if (st === null) break;
    stops.push(st);
  }
  const cardStops = stops.filter((s) => s.card);
  expect(cardStops.length).toBe(8);
  // Visual order: header controls left to right, toolbar left to right, cards by row then column.
  const nonCards = stops.filter((s) => !s.card);
  expect(nonCards.length).toBeGreaterThanOrEqual(6); // 2 links, 2 header buttons, 2 selects
  expect(stops.findIndex((s) => s.card)).toBe(nonCards.length); // controls precede the grid
  const rowOf = (s: { y: number }) => Math.round(s.y / 20);
  for (let i = 1; i < cardStops.length; i++) {
    const a = cardStops[i - 1]!;
    const b = cardStops[i]!;
    const sameRow = Math.abs(a.y - b.y) < 20;
    expect(sameRow ? b.x > a.x : b.y > a.y, `card ${i} follows card ${i - 1} visually`).toBe(true);
    void rowOf;
  }
  const header = nonCards.slice(0, 4);
  for (let i = 1; i < header.length; i++) expect(header[i]!.x).toBeGreaterThan(header[i - 1]!.x);
  const tools = nonCards.slice(4);
  for (let i = 1; i < tools.length; i++) expect(tools[i]!.x).toBeGreaterThan(tools[i - 1]!.x);
  // The DOM order of cards equals the visual order (cards are tab stops; compared to the list).
  const domIds = await page
    .locator('[data-testid="session-card"]')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).getAttribute("aria-label")));
  expect(cardStops.map((s) => s.label)).toEqual(domIds);
  // Focus visible: every stop draws a solid outline of at least 2 px.
  for (const s of stops) {
    expect(s.outline.startsWith("solid"), `outline on ${s.label}`).toBe(true);
    expect(s.w, `outline width on ${s.label}`).toBeGreaterThanOrEqual(2);
  }

  // Shortcuts: c toggles compact, j focuses a card, Enter opens the dialog, Esc closes and returns.
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  const compactBtn = page.getByRole("button", { name: /^Compact/ });
  await expect(compactBtn).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("c");
  await expect(compactBtn).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("c");
  await expect(compactBtn).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("j");
  const first = page.locator('[data-testid="session-card"]').first();
  await expect(first).toBeFocused();
  await page.keyboard.press("j");
  await expect(page.locator('[data-testid="session-card"]').nth(1)).toBeFocused();
  await page.keyboard.press("k");
  await expect(first).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(first).toBeFocused();
});

for (const density of ["full", "compact"] as const) {
  test(`R3.7 live: 320 px reflow and 400% zoom equivalents lose no content (${density})`, async ({
    page,
  }) => {
    for (const [w, h] of [
      [320, 640],
      [320, 256], // 1280 x 1024 at 400% zoom
      [640, 450], // 1280 x 900 at 200% zoom
    ] as const) {
      await page.setViewportSize({ width: w, height: h });
      await openSettledBoard(page);
      if (density === "compact") {
        await page.locator("body").click({ position: { x: 1, y: 1 } });
        // The choice persists across reloads (R3.4), so only toggle when not already compact.
        const pressed = await page
          .getByRole("button", { name: /^Compact/ })
          .getAttribute("aria-pressed");
        if (pressed !== "true") await page.keyboard.press("c");
        await expect(page.locator('[data-testid="session-card"]').first()).toHaveAttribute(
          "data-density",
          "compact",
        );
      }
      await filterToHiddenAttention(page);
      const m = await page.evaluate(() => {
        const main = document.querySelector("main")!;
        const over: string[] = [];
        for (const el of document.querySelectorAll("header *, main *")) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1)) {
            over.push(
              `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""} ${Math.round(r.left)}..${Math.round(r.right)}`,
            );
          }
        }
        return {
          docW: document.documentElement.scrollWidth,
          mainW: main.scrollWidth,
          mainC: main.clientWidth,
          over: over.slice(0, 8),
        };
      });
      const clippedInCards = await page.evaluate(() => {
        const out: string[] = [];
        for (const card of document.querySelectorAll('[data-testid="session-card"]')) {
          const c = card.getBoundingClientRect();
          for (const el of card.querySelectorAll("*")) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && (r.right > c.right + 1 || r.bottom > c.bottom + 1)) {
              out.push(
                `${el.tagName.toLowerCase()}[${el.getAttribute("data-slot") ?? ""}] ${el.textContent?.slice(0, 20)}`,
              );
            }
          }
        }
        return out.slice(0, 6);
      });
      const truncatedNumbers = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-slot="value"]')).filter(
            (e) => e.scrollWidth > e.clientWidth,
          ).length,
      );
      expect(truncatedNumbers, `${w}x${h} meter numbers truncated`).toBe(0);
      // Anything clipped by overflow that is not an ellipsised, titled label is lost content.
      const clippedText = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>(
          'main [data-testid="session-card"], main [data-testid="session-card"] *',
        )) {
          const cs = getComputedStyle(el);
          if (cs.overflowX === "visible" && el.tagName !== "ARTICLE") continue;
          if (cs.textOverflow === "ellipsis" || el.classList.contains("sr-only")) continue;
          if (el.scrollWidth > el.clientWidth + 1) {
            out.push(
              `${el.tagName.toLowerCase()}[${el.dataset["slot"] ?? el.dataset["row"] ?? ""}] ${el.scrollWidth}>${el.clientWidth}`,
            );
          }
        }
        return out.slice(0, 6);
      });
      expect(clippedText, `${w}x${h} card content clipped`).toEqual([]);
      expect(clippedInCards, `${w}x${h} card content outside its card`).toEqual([]);
      expect(m.over, `${w}x${h} elements outside the viewport`).toEqual([]);
      expect(m.docW, `${w}x${h} page scrolls sideways`).toBeLessThanOrEqual(w);
      expect(m.mainW, `${w}x${h} main scrolls sideways`).toBeLessThanOrEqual(m.mainC);
      // The primary information is still there: toolbar controls and the count.
      await expect(page.locator("#board-filter-host")).toBeVisible();
      await expect(page.locator("#board-filter-project")).toBeVisible();
      await expect(page.getByTestId("board-count")).toBeVisible();
      await expect(page.getByTestId("board-hidden-attention")).toBeVisible();
      await expect(page.getByTestId("connection")).toBeVisible();
      if (w === 320 && h === 640) {
        await setConnection(page, "closed", 5000);
        await page.screenshot({ path: shot("R3.7-320.png") });
        const box = await page.getByTestId("connection-banner").locator("p").boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      }
      await page.locator("#board-filter-project").selectOption("");
    }
  });
}

test("R3.2 at 320 px a meter row going null to value moves no meter box", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openSettledBoard(page);
  type Store = {
    getState: () => { sessions: Record<string, Record<string, unknown>> };
    setState: (p: unknown) => void;
  };
  const patch = (p: { ctx: unknown; rl: unknown }) =>
    page.evaluate((arg) => {
      const b = (window as unknown as { __sd: { board: Store } }).__sd.board;
      const s = b.getState().sessions;
      const id = Object.keys(s)[0]!;
      b.setState({
        sessions: { ...s, [id]: { ...s[id], context: arg.ctx, rate_limits: arg.rl } },
      });
      return id;
    }, p);
  const boxes = async (id: string) =>
    page.evaluate((sid) => {
      const card = document.querySelector(`[data-session-id="${sid}"]`)!;
      return Array.from(card.querySelectorAll<HTMLElement>("[data-meter]")).map((m) => {
        const r = m.getBoundingClientRect();
        const v = m.querySelector<HTMLElement>('[data-slot="value"]')!;
        // The leading percent (first 4 chars or the whole "n/a") must be fully inside the value box.
        const rng = document.createRange();
        const node = v.firstChild!;
        rng.setStart(node, 0);
        rng.setEnd(node, Math.min(4, node.textContent!.length));
        const lead = rng.getBoundingClientRect();
        const vr = v.getBoundingClientRect();
        return {
          kind: m.dataset["meter"],
          x: r.x,
          y: r.y,
          w: r.width,
          h: r.height,
          text: v.textContent,
          cut: lead.right > vr.right + 0.5,
        };
      });
    }, id);
  const nullCtx = { used_pct: null, window: null, input: null, output: null };
  const id = await patch({
    ctx: nullCtx,
    rl: { five_hour: null, seven_day: null, captured_at: null },
  });
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const before = await boxes(id);
  expect(before.map((b) => b.text)).toEqual(["n/a", "n/a", "n/a"]);
  const future = Date.now() + 3_600_000;
  await patch({
    ctx: { used_pct: 100, window: 1_000_000, input: 1, output: 1 },
    rl: {
      five_hour: { used_pct: 100, resets_at: future },
      seven_day: { used_pct: 100, resets_at: future },
      captured_at: future,
    },
  });
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const after = await boxes(id);
  expect(after.map((b) => b.text?.slice(0, 4))).toEqual(["100%", "100%", "100%"]);
  for (let i = 0; i < 3; i++) {
    const a = before[i]!;
    const b = after[i]!;
    expect({ x: b.x, y: b.y, w: b.w, h: b.h }, `${a.kind} meter box`).toEqual({
      x: a.x,
      y: a.y,
      w: a.w,
      h: a.h,
    });
    expect(b.cut, `${a.kind} leading number cut off`).toBe(false);
  }
});

test("R3.7 live: text spacing override (1.4.12) clips nothing in toolbar, header and banner", async ({
  page,
}) => {
  await openSettledBoard(page);
  await setConnection(page, "closed", 5000);
  await page.addStyleTag({
    content: `* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }`,
  });
  const clipped = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll(
      "header *, [data-testid=board-toolbar] *, [data-testid=connection-banner] *",
    )) {
      const e = el as HTMLElement;
      if (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== "visible")
        out.push(e.tagName + e.textContent?.slice(0, 20));
    }
    const hdr = document.querySelector("header")!.getBoundingClientRect();
    const tb = document.querySelector("[data-testid=board-toolbar]")!.getBoundingClientRect();
    if (document.documentElement.scrollWidth > window.innerWidth) out.push("page scrolls sideways");
    out.push(...(hdr.bottom > tb.top + 1 ? ["header overlaps toolbar"] : []));
    return out;
  });
  expect(clipped).toEqual([]);
  const cardClip = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-testid="session-card"]')).filter(
        (c) => c.scrollHeight > c.clientHeight + 1,
      ).length,
  );
  expect(cardClip, "cards whose content outgrows the fixed height under 1.4.12 spacing").toBe(0);
});

test("R3.7 live: arrival glow is one 400 ms opacity pass, off under reduced motion", async ({
  page,
}) => {
  // Reduced motion (project default): no animation on the glow layer.
  await openSettledBoard(page);
  const anim = (p: Page) =>
    p.evaluate(() => {
      const card = document.querySelector<HTMLElement>('[data-attention="true"]')!;
      const cs = getComputedStyle(card, "::after");
      return {
        name: cs.animationName,
        dur: cs.animationDuration,
        count: cs.animationIterationCount,
      };
    });
  expect((await anim(page)).name).toBe("none");
  // The same CSS with motion allowed: a single 0.4 s pass (2.2.2 exempt under 5 s; 2.3.1: 1 flash).
  const css = await page.evaluate(() => {
    const rules: string[] = [];
    for (const sheet of Array.from(document.styleSheets))
      for (const r of Array.from(sheet.cssRules)) rules.push(r.cssText);
    return rules.join("\n");
  });
  expect(css).toMatch(
    /\.sd-attention\.sd-arrive::after\s*\{[^}]*animation:\s*sd-glow \.4s[^}]*\b1\b/,
  );
  expect(css).toMatch(/@keyframes sd-glow/);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('[data-attention="true"]')!;
    card.classList.add("sd-arrive");
  });
  const live = await anim(page);
  expect(live).toEqual({ name: "sd-glow", dur: "0.4s", count: "1" });
  // Reduced motion: also the pulse stops and transitions collapse.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await page.evaluate(() => {
    const dot = document.querySelector<HTMLElement>(".sd-pulse");
    return {
      glow: getComputedStyle(document.querySelector('[data-attention="true"]')!, "::after")
        .animationName,
      pulse: dot ? getComputedStyle(dot).animationName : "no-pulse-element",
    };
  });
  expect(reduced.glow).toBe("none");
  expect(reduced.pulse === "none" || reduced.pulse === "no-pulse-element").toBe(true);
  writeFileSync(shot("R3.7-motion.json"), JSON.stringify({ live, reduced }, null, 2));
});

test("R3.7 live: tones and notifications are off by default (1.4.2)", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { AudioContext?: new () => unknown; __audioCreated?: number };
    const Orig = w.AudioContext;
    if (Orig) {
      w.AudioContext = function (this: unknown) {
        w.__audioCreated = (w.__audioCreated ?? 0) + 1;
        return new Orig();
      } as unknown as new () => unknown;
    }
  });
  await openSettledBoard(page);
  const settings = await page.evaluate(() =>
    JSON.stringify(
      (
        window as unknown as { __sd: { ui: { getState: () => { settings: unknown } } } }
      ).__sd.ui.getState().settings,
    ),
  );
  const s = JSON.parse(settings) as {
    notifications: boolean;
    sounds: Record<string, boolean>;
    muted: boolean;
  };
  expect(s.notifications).toBe(false);
  expect(Object.values(s.sounds)).toEqual([false, false]);
  const audio = await page.evaluate(
    () => (window as unknown as { __audioCreated?: number }).__audioCreated ?? 0,
  );
  expect(audio).toBe(0);
});
