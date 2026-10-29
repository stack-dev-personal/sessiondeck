import { SESSION_STATES } from "@sessiondeck/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBoardStore } from "../store/board";
import { playTimeline } from "./player";
import { startMock } from "./start";
import { buildAgentTree } from "../lib/agent-tree";
import { deriveDisplay } from "../lib/display-activity";
import {
  buildMockTimeline,
  DEFAULT_FLAP_MS,
  flapEnvelope,
  MOCK_DEEP_SESSION,
  synthText,
} from "./timeline";

const NOW = 1_792_400_000_000;

describe("mock replay", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", () => {
      throw new Error("network used in mock mode");
    });
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor() {
          throw new Error("WebSocket used in mock mode");
        }
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("builds a strictly ordered, schema-shaped timeline", () => {
    const tl = buildMockTimeline(NOW);
    expect(tl.length).toBeGreaterThan(500);
    for (let i = 1; i < tl.length; i++) expect(tl[i]!.ts).toBeGreaterThan(tl[i - 1]!.ts);
    expect(new Set(tl.map((e) => e.host))).toEqual(new Set(["stack-lap", "stack-box"]));
    expect(new Set(tl.map((e) => e.kind))).toEqual(new Set(["hook", "liveness", "statusline"]));
  });

  it("runs to completion and yields many states on 2 hosts with no network", () => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"],
    });
    const store = createBoardStore();
    const onDone = vi.fn();
    playTimeline(buildMockTimeline(NOW), store.getState().enqueue, { onDone });
    expect(() => vi.advanceTimersByTime(10 * 60_000)).not.toThrow();
    expect(onDone).toHaveBeenCalledTimes(1);
    const list = Object.values(store.getState().sessions);
    expect(list).toHaveLength(8);
    expect(new Set(list.map((s) => s.host)).size).toBe(2);
    const states = new Set(list.map((s) => s.state));
    expect(states).toEqual(
      new Set([
        "waiting_permission",
        "idle",
        "working",
        "ended",
        "starting",
        "waiting_input",
        "error",
        "exited",
      ]),
    );
    for (const s of states) expect(SESSION_STATES).toContain(s);
    // statusLine data landed: context and 5h window populated for a live session
    const withCtx = list.filter((s) => s.context.used_pct !== null);
    expect(withCtx.length).toBeGreaterThanOrEqual(3);
    expect(list.some((s) => s.rate_limits.five_hour?.used_pct != null)).toBe(true);
    expect(list.every((s) => s.session_id.startsWith("mock-"))).toBe(true);
  });

  it("startMock marks the connection as mock and plays through the store", () => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"],
    });
    const store = createBoardStore();
    const cancel = startMock(store);
    expect(store.getState().connection).toBe("mock");
    vi.advanceTimersByTime(1000);
    expect(Object.keys(store.getState().sessions).length).toBeGreaterThan(0);
    cancel();
  });

  it("cancel stops delivery", () => {
    vi.useFakeTimers();
    const got: number[] = [];
    const cancel = playTimeline(buildMockTimeline(NOW), (e) => got.push(e.seq));
    cancel();
    const n = got.length;
    vi.advanceTimersByTime(5000);
    expect(got).toHaveLength(n);
  });

  it("settles populated: ctx and both windows on at least 6 sessions, agents, tasks, no placeholders", () => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"],
    });
    const store = createBoardStore();
    playTimeline(buildMockTimeline(NOW), store.getState().enqueue);
    vi.advanceTimersByTime(10 * 60_000);
    const list = Object.values(store.getState().sessions);
    const full = list.filter(
      (s) =>
        s.context.used_pct !== null &&
        s.rate_limits.five_hour?.used_pct != null &&
        s.rate_limits.seven_day?.used_pct != null,
    );
    expect(full.length).toBeGreaterThanOrEqual(6);
    expect(list.filter((s) => s.subagents.length > 0).length).toBeGreaterThanOrEqual(2);
    expect(list.filter((s) => s.tasks.total > 0).length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(list)).not.toMatch(/<TEXT|<HOME>|<PROJECT/);
    const names = list.map((s) => s.session_name ?? s.project_dir);
    expect(new Set(names).size).toBe(list.length);
    expect(new Set(list.filter((s) => s.session_name).map((s) => s.session_name)).size).toBe(
      list.filter((s) => s.session_name).length,
    );
    expect(list.filter((s) => s.git.branch !== null).length).toBeGreaterThanOrEqual(6);
    const busiest = list.find((s) => s.session_id.startsWith("mock-sessiondeck"))!;
    expect(busiest.last_prompt).toBeTruthy();
    expect(busiest.last_assistant_message).toBeTruthy();
    expect(busiest.last_prompt).not.toBe(busiest.last_assistant_message);
  });

  it("settled sessions show at least 3 distinct last assistant texts", () => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"],
    });
    const store = createBoardStore();
    playTimeline(buildMockTimeline(NOW), store.getState().enqueue);
    vi.advanceTimersByTime(10 * 60_000);
    const texts = Object.values(store.getState().sessions).map((s) => s.last_assistant_message);
    expect(new Set(texts.filter(Boolean)).size).toBeGreaterThanOrEqual(3);
  });

  it("fills placeholders from the pool of the field they sit in", () => {
    const tl = buildMockTimeline(NOW);
    const prompts = new Set<string>();
    const replies = new Set<string>();
    for (const e of tl) {
      const p = e.payload as Record<string, unknown>;
      if (typeof p.prompt === "string") prompts.add(p.prompt);
      if (typeof p.last_assistant_message === "string") replies.add(p.last_assistant_message);
    }
    expect(prompts.size).toBeGreaterThan(0);
    expect(replies.size).toBeGreaterThan(0);
    for (const n of [28, 102, 403, 4352]) {
      expect(synthText(n, "prompt")).not.toBe(synthText(n, "last_assistant_message"));
    }
    for (const m of replies) expect(prompts.has(m)).toBe(false);
    expect(synthText(102, "prompt").length).toBeGreaterThan(20);
    expect(["Tests pass", "Done", "Ok"]).toContain(synthText(42, "last_assistant_message"));
  });

  it("?replay=fast delivers quickly and sets data-replay=done", () => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"],
    });
    window.history.pushState({}, "", "/board?replay=fast");
    try {
      const store = createBoardStore();
      startMock(store);
      expect(document.documentElement.dataset["replay"]).toBe("running");
      vi.advanceTimersByTime(3000);
      expect(document.documentElement.dataset["replay"]).toBe("done");
      expect(Object.keys(store.getState().sessions)).toHaveLength(8);
    } finally {
      window.history.pushState({}, "", "/");
      delete document.documentElement.dataset["replay"];
    }
  });
});

describe("mock covers R3.10 to R3.12 (R3.13)", () => {
  const fake = () =>
    vi.useFakeTimers({
      toFake: [
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "setTimeout",
        "clearTimeout",
        "Date",
      ],
    });
  afterEach(() => {
    vi.useRealTimers();
    window.history.pushState({}, "", "/");
    delete document.documentElement.dataset["replay"];
  });

  it("one session has subagents linked three levels deep and one unlinked", () => {
    fake();
    window.history.pushState({}, "", "/board?replay=fast");
    const store = createBoardStore();
    startMock(store);
    vi.advanceTimersByTime(5000);
    const s = store.getState().sessions[MOCK_DEEP_SESSION]!;
    const tree = buildAgentTree(s.subagents);
    const depth = (n: (typeof tree)[number]): number => 1 + Math.max(0, ...n.children.map(depth));
    expect(Math.max(...tree.map(depth))).toBe(3);
    expect(tree.filter((n) => n.unlinked).length).toBeGreaterThanOrEqual(1);
    expect(tree.filter((n) => !n.unlinked).length).toBeGreaterThanOrEqual(1);
    for (const a of s.subagents.filter((x) => x.parent_agent_id !== null)) {
      expect(a.parent_known).toBe(true);
    }
  });

  it("rate_limits carry only five_hour and seven_day, on several sessions", () => {
    fake();
    const store = createBoardStore();
    playTimeline(buildMockTimeline(NOW), store.getState().enqueue);
    vi.advanceTimersByTime(10 * 60_000);
    const list = Object.values(store.getState().sessions);
    expect(
      list.filter((s) => s.rate_limits.five_hour && s.rate_limits.seven_day).length,
    ).toBeGreaterThanOrEqual(6);
    for (const s of list) {
      expect(Object.keys(s.rate_limits).sort()).toEqual(["captured_at", "five_hour", "seven_day"]);
    }
    // Decision 28: no per-model (Fable) window anywhere in the statusLine payloads either.
    for (const e of buildMockTimeline(NOW).filter((x) => x.kind === "statusline")) {
      const rl = (e.payload as { rate_limits?: Record<string, unknown> }).rate_limits ?? {};
      for (const k of Object.keys(rl)) expect(["five_hour", "seven_day"]).toContain(k);
    }
  });

  it("the no-usage variant never reports a rate limit (empty widget)", () => {
    fake();
    const store = createBoardStore();
    playTimeline(buildMockTimeline(NOW, { usage: false }), store.getState().enqueue);
    vi.advanceTimersByTime(10 * 60_000);
    const list = Object.values(store.getState().sessions);
    expect(list).toHaveLength(8);
    for (const s of list) {
      expect(s.rate_limits.five_hour).toBeNull();
      expect(s.rate_limits.seven_day).toBeNull();
    }
  });

  it("?usage=none selects the no-usage variant", () => {
    fake();
    window.history.pushState({}, "", "/board?replay=fast&usage=none");
    const store = createBoardStore();
    startMock(store);
    vi.advanceTimersByTime(5000);
    const list = Object.values(store.getState().sessions);
    expect(list.every((s) => s.rate_limits.five_hour === null)).toBe(true);
  });

  it("the flapper alternates Stop and prompt every 30 s and stays in the working group", () => {
    fake();
    window.history.pushState({}, "", "/board?replay=fast");
    const store = createBoardStore();
    startMock(store);
    vi.advanceTimersByTime(5000);
    const id = MOCK_DEEP_SESSION;
    expect(DEFAULT_FLAP_MS).toBe(30_000);
    expect(store.getState().sessions[id]!.state).toBe("working");
    const seen: string[] = [];
    let tracked = new Map();
    for (let i = 1; i <= 8; i++) {
      vi.advanceTimersByTime(DEFAULT_FLAP_MS);
      const s = store.getState().sessions[id]!;
      seen.push(s.state);
      // hysteresis at the default 120 s grace, evaluated at the simulated wall time (Date is faked)
      tracked = deriveDisplay(tracked, [s], Date.now(), 120_000);
      expect(tracked.get(id).group).toBe("working");
    }
    expect(seen.slice(0, 4)).toEqual(["idle", "working", "idle", "working"]);
    expect(store.getState().sessions[id]!.subagents.length).toBeGreaterThanOrEqual(4);
  });

  it("flapEnvelope builds Stop and UserPromptSubmit hooks for the deep session", () => {
    const stop = flapEnvelope("Stop", NOW, 1);
    const go = flapEnvelope("UserPromptSubmit", NOW + 1, 2);
    expect(stop.session_id).toBe(MOCK_DEEP_SESSION);
    expect(stop.hook_event_name).toBe("Stop");
    expect(go.hook_event_name).toBe("UserPromptSubmit");
    expect(go.ts).toBeGreaterThan(stop.ts);
  });

  it("?flap=0 turns the ticker off", () => {
    fake();
    window.history.pushState({}, "", "/board?replay=fast&flap=0");
    const store = createBoardStore();
    startMock(store);
    vi.advanceTimersByTime(5000);
    const before = store.getState().sessions[MOCK_DEEP_SESSION]!.state;
    vi.advanceTimersByTime(5 * 60_000);
    expect(store.getState().sessions[MOCK_DEEP_SESSION]!.state).toBe(before);
  });
});
