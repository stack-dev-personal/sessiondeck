import { expect, test, type Page } from "@playwright/test";
import {
  HOST,
  LIVE,
  card,
  configureHub,
  hookEnvelope,
  ingest,
  newSessionId,
  waitConnected,
} from "./live-helpers";
import { shot } from "./helpers";

test.skip(LIVE.hubUrl === "", "live spec: set SD_E2E_HUB_URL (see playwright.config.ts)");

const HOST2 = `${HOST}-b`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rnd = Math.random().toString(36).slice(2, 6);
const ALPHA = `r33a${rnd}`;
const BETA = `r33b${rnd}`;

const start = (id: string, cwd: string, host: string) =>
  hookEnvelope(id, "SessionStart", "SessionStart/01-startup.json", { cwd }, host);
const permission = (id: string, cwd: string) =>
  hookEnvelope(id, "PermissionRequest", "PermissionRequest/03-bash.json", { cwd });
const askTool = (id: string, cwd: string) =>
  hookEnvelope(id, "PreToolUse", "PreToolUse/04-askuserquestion.json", { cwd });
const stopAsk = (id: string, cwd: string) =>
  hookEnvelope(id, "Stop", "Stop/01-after-ask.json", { cwd });
const idlePrompt = (id: string, cwd: string) =>
  hookEnvelope(id, "Notification", "Notification/01-idle-prompt.json", { cwd });

/** Visible card ids in DOM order. */
const order = (page: Page) =>
  page
    .locator('[data-testid="session-card"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-session-id")));

test("R3.3 attention sort, accent, one notification per transition, filters", async ({ page }) => {
  test.setTimeout(90_000);
  // Browser stubs, before any page script: a granted Notification that records calls, and a
  // WebSocket wrapper that stamps the arrival of hub messages (listener runs before the app's).
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w["__notifs"] = [];
    class FakeNotification {
      static permission = "granted";
      static requestPermission() {
        return Promise.resolve("granted");
      }
      onclick: unknown = null;
      constructor(title: string, o?: { body?: string; tag?: string }) {
        (w["__notifs"] as unknown[]).push({ title, body: o?.body, tag: o?.tag });
      }
      close() {}
    }
    w["Notification"] = FakeNotification;
    const Native = window.WebSocket;
    w["__msg"] = {};
    w["__frame"] = 0;
    const tick = () => {
      (w["__frame"] as number)++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", (ev) => {
          const d = typeof ev.data === "string" ? ev.data : "";
          for (const key of Object.keys(w["__watch"] ?? {})) {
            const [sid, st] = key.split("|");
            if (d.includes(sid!) && d.includes(`"${st}"`) && !(key in (w["__msg"] as object))) {
              (w["__msg"] as Record<string, unknown>)[key] = {
                t: performance.now(),
                f: w["__frame"],
              };
            }
          }
        });
      }
    };
  });
  await configureHub(page, { notifications: true });
  await page.goto("/board");
  await waitConnected(page);

  const [a, b, c, d] = [newSessionId(), newSessionId(), newSessionId(), newSessionId()] as [
    string,
    string,
    string,
    string,
  ];
  const cwdA = `/w/${ALPHA}`;
  const cwdB = `/w/${BETA}`;
  // a is the oldest, so it is last of the four in last-event order.
  for (const [id, cwd, host] of [
    [a, cwdA, HOST],
    [b, cwdA, HOST],
    [c, cwdB, HOST],
    [d, cwdA, HOST2],
  ] as const) {
    await ingest(
      [
        start(id, cwd, host),
        hookEnvelope(id, "UserPromptSubmit", "UserPromptSubmit/01-sample.json", { cwd }, host),
      ],
      host,
    );
    await sleep(30);
  }
  for (const id of [a, b, c, d])
    await expect(card(page, id)).toHaveAttribute("data-state", "working");
  const mine = async () => (await order(page)).filter((i) => [a, b, c, d].includes(i!));
  expect(await mine()).toEqual([d, c, b, a]);
  const notifs = () => page.evaluate(() => (window as never as { __notifs: unknown[] }).__notifs);
  expect(await notifs()).toHaveLength(0);

  // Watch for a's permission state: record when the message arrives and when the DOM shows it,
  // with a's position in that same DOM mutation callback.
  await page.evaluate((sid) => {
    const w = window as unknown as Record<string, unknown>;
    w["__watch"] = { [`${sid}|waiting_permission`]: true };
    const seen = {} as Record<string, unknown>;
    w["__dom"] = seen;
    new MutationObserver(() => {
      const key = `${sid}|waiting_permission`;
      if (key in seen) return;
      const cards = Array.from(document.querySelectorAll('[data-testid="session-card"]'));
      const i = cards.findIndex((el) => el.getAttribute("data-session-id") === sid);
      if (i !== -1 && cards[i]!.getAttribute("data-state") === "waiting_permission") {
        seen[key] = { t: performance.now(), f: w["__frame"], index: i };
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true });
  }, a);

  await ingest([permission(a, cwdA)]);
  await expect(card(page, a)).toHaveAttribute("data-state", "waiting_permission");
  const probe = await page.evaluate((sid) => {
    const w = window as unknown as Record<
      string,
      Record<string, { t: number; f: number; index: number }>
    >;
    const k = `${sid}|waiting_permission`;
    return { msg: w["__msg"]![k], dom: w["__dom"]![k] };
  }, a);
  expect(probe.msg).toBeDefined();
  expect(probe.dom).toBeDefined();
  const ms = probe.dom!.t - probe.msg!.t;
  const frames = probe.dom!.f - probe.msg!.f;
  console.log(
    `R3.3 reorder latency: ${ms.toFixed(1)} ms, ${frames} frames, index ${probe.dom!.index}`,
  );
  // The state text and the position changed in the same DOM mutation: first card at that moment.
  expect(probe.dom!.index).toBe(0);
  expect(frames).toBeLessThanOrEqual(2);
  expect(ms).toBeLessThan(100);

  expect((await mine())[0]).toBe(a);
  const top = card(page, a);
  await expect(top).toHaveAttribute("data-attention", "true");
  await expect(top).toHaveClass(/sd-attention/);
  await expect(top.locator('[data-slot="badge"]')).toHaveText("attention");
  await expect(top).toContainText("Needs permission");
  await expect(card(page, b)).not.toHaveAttribute("data-attention", "true");
  let n = (await notifs()) as { title: string; body: string; tag: string }[];
  expect(n).toHaveLength(1);
  expect(n[0]!.body).toBe("Needs permission");
  expect(n[0]!.tag).toBe(`sd-${a}`);
  await page.screenshot({ path: shot("R3.3.png") });

  // More deltas while still waiting: no new notification, the card stays on top.
  await ingest([permission(a, cwdA), idlePrompt(a, cwdA)]);
  await sleep(300);
  await expect(card(page, a)).toHaveAttribute("data-state", "waiting_permission");
  expect(await notifs()).toHaveLength(1);
  expect((await mine())[0]).toBe(a);

  // A second session reaches waiting_input (AskUserQuestion, then Stop): moves above a, one more.
  await ingest([askTool(b, cwdA), stopAsk(b, cwdA)]);
  await expect(card(page, b)).toHaveAttribute("data-state", "waiting_input");
  expect((await mine()).slice(0, 2)).toEqual([b, a]);
  await expect(card(page, b)).toHaveAttribute("data-attention", "true");
  await expect(card(page, b)).toContainText("Needs input");
  n = (await notifs()) as typeof n;
  expect(n).toHaveLength(2);
  expect(n[1]!.body).toBe("Needs input");
  await ingest([idlePrompt(b, cwdA)]);
  await sleep(300);
  expect(await notifs()).toHaveLength(2);

  // Filters: host, project, both; persisted across a reload; no layout shift in the toolbar.
  const toolbar = page.getByTestId("board-toolbar");
  const box = await toolbar.boundingBox();
  await page.getByLabel("Host", { exact: true }).selectOption(HOST2);
  await expect(page.getByTestId("session-card")).toHaveCount(1);
  await expect(card(page, d)).toBeVisible();
  expect(await toolbar.boundingBox()).toEqual(box);
  await page.getByLabel("Host", { exact: true }).selectOption("");
  await page.getByLabel("Project", { exact: true }).selectOption(ALPHA);
  await expect(page.getByTestId("session-card")).toHaveCount(3);
  await expect(card(page, c)).toHaveCount(0);
  await page.getByLabel("Host", { exact: true }).selectOption(HOST);
  await expect(page.getByTestId("session-card")).toHaveCount(2);
  expect(await order(page)).toEqual([b, a]);
  await expect(page.getByTestId("board-count")).toContainText("Showing 2 of");
  await page.screenshot({ path: shot("R3.3-filters.png") });
  await page.reload();
  await waitConnected(page);
  await expect(page.getByLabel("Host", { exact: true })).toHaveValue(HOST);
  await expect(page.getByLabel("Project", { exact: true })).toHaveValue(ALPHA);
  await expect(page.getByTestId("session-card")).toHaveCount(2);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(card(page, d)).toBeVisible();
  await expect(card(page, c)).toBeVisible();

  // Leave the hub clean for the next spec (R3.9 asserts no working card remains).
  const end = (id: string, cwd: string) =>
    hookEnvelope(id, "SessionEnd", "SessionEnd/01-other.json", { cwd });
  await ingest([end(a, cwdA), end(b, cwdA), end(c, cwdB)]);
  await ingest(
    [hookEnvelope(d, "SessionEnd", "SessionEnd/01-other.json", { cwd: cwdA }, HOST2)],
    HOST2,
  );
  await expect(card(page, a)).toHaveAttribute("data-state", "ended");
  await expect(card(page, d)).toHaveAttribute("data-state", "ended");
});
