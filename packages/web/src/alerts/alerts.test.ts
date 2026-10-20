import { createSnapshot, type SessionSnapshot, type SessionState } from "@sessiondeck/contract";
import { create } from "zustand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../store/ui";
import { createBoardStore } from "../store/board";
import { createAttentionDetector } from "./detect";
import { notificationText, resetAudioForTests, type AlertEnv } from "./deliver";
import { startAlerts } from "./start";

function snap(id: string, state: SessionState, over: Partial<SessionSnapshot> = {}) {
  return {
    ...createSnapshot({ session_id: id, host: "h", cwd: `/w/${id}`, ts: 1 }),
    state,
    ...over,
  } as SessionSnapshot;
}
const map = (...l: SessionSnapshot[]) => Object.fromEntries(l.map((s) => [s.session_id, s]));

describe("createAttentionDetector", () => {
  it("reports a transition into waiting_permission once, not on repeated deltas", () => {
    const d = createAttentionDetector();
    expect(d.observe(map(snap("a", "working")))).toEqual([]);
    const ev = d.observe(map(snap("a", "waiting_permission")));
    expect(ev.map((e) => [e.sessionId, e.state])).toEqual([["a", "waiting_permission"]]);
    expect(d.observe(map(snap("a", "waiting_permission", { last_event_at: 99 })))).toEqual([]);
    expect(d.observe(map(snap("a", "waiting_permission", { cost: { usd: 3 } } as never)))).toEqual(
      [],
    );
  });

  it("fires again after leaving and re-entering", () => {
    const d = createAttentionDetector();
    d.observe(map(snap("a", "waiting_input")));
    expect(d.observe(map(snap("a", "working")))).toEqual([]);
    expect(d.observe(map(snap("a", "waiting_input")))).toHaveLength(1);
  });

  it("treats permission -> input as a new transition", () => {
    const d = createAttentionDetector();
    d.observe(map(snap("a", "waiting_permission")));
    const ev = d.observe(map(snap("a", "waiting_input")));
    expect(ev.map((e) => e.state)).toEqual(["waiting_input"]);
  });

  it("reports a session already waiting at the first observation once (initial)", () => {
    const d = createAttentionDetector();
    expect(d.observe(map(snap("a", "waiting_input"), snap("b", "idle")))).toHaveLength(1);
  });

  it("does not re-notify an already-seen episode after a resync with new objects", () => {
    const d = createAttentionDetector();
    d.observe(map(snap("a", "waiting_permission")));
    expect(d.observe(map(snap("a", "waiting_permission")))).toEqual([]);
  });

  it("reports a session that began waiting during the disconnect, and forgets removed ones", () => {
    const d = createAttentionDetector();
    d.observe(map(snap("a", "working"), snap("b", "waiting_input")));
    // resync: a is now waiting (changed while cut off), b is gone
    expect(d.observe(map(snap("a", "waiting_permission"))).map((e) => e.sessionId)).toEqual(["a"]);
    // b comes back waiting: a new episode
    expect(
      d.observe(map(snap("a", "waiting_permission"), snap("b", "waiting_input"))),
    ).toHaveLength(1);
  });
});

describe("startAlerts delivery", () => {
  let calls: { title: string; options?: NotificationOptions }[];
  let tones: number[];
  let env: AlertEnv;
  const frames: (() => void)[] = [];
  const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

  beforeEach(() => {
    calls = [];
    tones = [];
    frames.length = 0;
    resetAudioForTests();
    class FakeNotification {
      static permission: NotificationPermission = "granted";
      onclick: unknown = null;
      constructor(title: string, options?: NotificationOptions) {
        calls.push({ title, options });
      }
      close() {}
    }
    class FakeAudio {
      currentTime = 0;
      destination = {};
      resume = () => Promise.resolve();
      createOscillator() {
        const o = {
          frequency: { value: 0 },
          connect: () => undefined,
          start: () => tones.push(o.frequency.value),
          stop: () => undefined,
        };
        return o;
      }
      createGain() {
        return {
          gain: { setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined },
          connect: () => undefined,
        };
      }
    }
    env = {
      Notification: FakeNotification as unknown as AlertEnv["Notification"],
      AudioContext: FakeAudio as unknown as AlertEnv["AudioContext"],
    };
  });
  afterEach(() => vi.restoreAllMocks());

  function setup(s: Settings) {
    const board = createBoardStore((cb) => {
      frames.push(cb);
    });
    const ui = create<{ settings: Settings }>()(() => ({ settings: s }));
    const stop = startAlerts(board, ui, env);
    const set = (...l: SessionSnapshot[]) => {
      for (const x of l) board.getState().enqueueSnapshot(x);
      frames.splice(0).forEach((f) => f());
    };
    return { board, ui, stop, set };
  }

  it("notifies once per transition with name and state label only", () => {
    const { set } = setup(settings({ notifications: true }));
    set(snap("a", "working", { session_name: "refactor", last_assistant_message: "SECRET text" }));
    expect(calls).toHaveLength(0);
    set(
      snap("a", "waiting_permission", {
        session_name: "refactor",
        last_assistant_message: "SECRET text",
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.title).toBe("refactor");
    expect(calls[0]!.options?.body).toBe("Needs permission");
    expect(JSON.stringify(calls[0])).not.toContain("SECRET");
    for (let i = 0; i < 5; i++) set(snap("a", "waiting_permission", { last_event_at: 10 + i }));
    expect(calls).toHaveLength(1);
    set(snap("a", "working"));
    set(snap("a", "waiting_input"));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.options?.body).toBe("Needs input");
  });

  it("does nothing when opted out, and opting in later does not announce what already waits", () => {
    const { set, ui } = setup(settings());
    set(snap("a", "waiting_permission"));
    expect(calls).toHaveLength(0);
    ui.setState({ settings: settings({ notifications: true }) });
    set(snap("a", "waiting_permission", { last_event_at: 5 }));
    expect(calls).toHaveLength(0);
    set(snap("b", "waiting_input"));
    expect(calls).toHaveLength(1);
  });

  it("does nothing without granted permission, and survives a throwing Notification", () => {
    (env.Notification as unknown as { permission: string }).permission = "denied";
    const { set } = setup(settings({ notifications: true }));
    set(snap("a", "waiting_permission"));
    expect(calls).toHaveLength(0);
    env.Notification = undefined;
    set(snap("b", "waiting_permission"));
    expect(calls).toHaveLength(0);
  });

  it("does not re-notify for an already-notified episode after replaceAll (resync)", () => {
    const { board, set } = setup(settings({ notifications: true }));
    set(snap("a", "waiting_permission"));
    expect(calls).toHaveLength(1);
    board.getState().replaceAll([snap("a", "waiting_permission")]);
    expect(calls).toHaveLength(1);
    // a session that started waiting while disconnected is announced once
    board.getState().replaceAll([snap("a", "waiting_permission"), snap("b", "waiting_input")]);
    expect(calls).toHaveLength(2);
  });

  it("plays one tone per transition only for opted-in states and honors the global mute", () => {
    const { set, ui } = setup(
      settings({ sounds: { waiting_permission: true, waiting_input: false } }),
    );
    set(snap("a", "waiting_permission"));
    set(snap("a", "waiting_permission", { last_event_at: 9 }));
    expect(tones).toEqual([880]);
    set(snap("b", "waiting_input"));
    expect(tones).toEqual([880]);
    ui.setState({
      settings: settings({
        sounds: { waiting_permission: true, waiting_input: true },
        muted: true,
      }),
    });
    set(snap("c", "waiting_permission"));
    expect(tones).toEqual([880]);
    ui.setState({
      settings: settings({ sounds: { waiting_permission: true, waiting_input: true } }),
    });
    set(snap("d", "waiting_input"));
    expect(tones).toEqual([880, 660]);
    expect(calls).toHaveLength(0);
  });

  it("stops delivering after unsubscribe", () => {
    const { set, stop } = setup(settings({ notifications: true }));
    stop();
    set(snap("a", "waiting_permission"));
    expect(calls).toHaveLength(0);
  });

  it("notificationText carries no transcript content", () => {
    const t = notificationText({
      sessionId: "a",
      state: "waiting_input",
      session: snap("a", "waiting_input", { last_assistant_message: "private" }),
    });
    expect(t).toEqual({ title: "a", body: "Needs input" });
  });
});
