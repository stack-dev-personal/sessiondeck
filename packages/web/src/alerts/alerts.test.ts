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

  it("calls onEnd when an episode ends or the session disappears", () => {
    const ended: string[] = [];
    const d = createAttentionDetector({ onEnd: (id) => ended.push(id) });
    d.observe(map(snap("a", "waiting_input"), snap("b", "waiting_input")));
    d.observe(map(snap("a", "working"), snap("b", "waiting_input")));
    expect(ended).toEqual(["a"]);
    d.observe(map(snap("a", "working")));
    expect(ended).toEqual(["a", "b"]);
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
  let closed: string[];
  let tones: number[];
  let env: AlertEnv;
  const frames: (() => void)[] = [];
  const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

  beforeEach(() => {
    calls = [];
    closed = [];
    tones = [];
    window.sessionStorage.clear();
    frames.length = 0;
    resetAudioForTests();
    class FakeNotification {
      static permission: NotificationPermission = "granted";
      onclick: unknown = null;
      tag: string;
      constructor(title: string, options?: NotificationOptions) {
        calls.push({ title, options });
        this.tag = options?.tag ?? "";
      }
      close() {
        closed.push(this.tag);
      }
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
    expect(calls[0]!.title).toBe("a needs permission");
    expect(calls[0]!.options?.body).toBe("refactor");
    expect(JSON.stringify(calls[0])).not.toContain("SECRET");
    for (let i = 0; i < 5; i++) set(snap("a", "waiting_permission", { last_event_at: 10 + i }));
    expect(calls).toHaveLength(1);
    set(snap("a", "working"));
    set(snap("a", "waiting_input"));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.title).toBe("a needs input");
  });

  it("closes the notification when the episode ends and tags each episode separately", () => {
    const { set } = setup(settings({ notifications: true }));
    set(snap("a", "waiting_permission", { state_since: 10 }));
    expect(closed).toEqual([]);
    set(snap("a", "working", { state_since: 20 }));
    expect(closed).toEqual(["sd-a-10"]);
    set(snap("a", "waiting_permission", { state_since: 30 }));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.options?.tag).toBe("sd-a-10");
    expect(calls[1]!.options?.tag).toBe("sd-a-30");
    expect(calls[1]!.options).not.toHaveProperty("renotify");
  });

  it("does not re-announce seen episodes after a reload (sessionStorage), but new ones", () => {
    const first = setup(settings({ notifications: true }));
    first.set(snap("a", "waiting_permission", { state_since: 10 }), snap("b", "idle"));
    expect(calls).toHaveLength(1);
    first.stop();
    const second = setup(settings({ notifications: true }));
    second.set(snap("a", "waiting_permission", { state_since: 10 }), snap("b", "idle"));
    // only the silent same-tag replace of the orphaned notification, no new announcement
    expect(calls.map((c) => c.options?.tag)).toEqual(["sd-a-10", "sd-a-10"]);
    second.set(
      snap("a", "waiting_permission", { state_since: 10 }),
      snap("b", "waiting_input", { state_since: 50 }),
    );
    expect(calls).toHaveLength(3);
    expect(calls[2]!.options?.tag).toBe("sd-b-50");
  });

  it("after a reload re-creates a still-waiting notification silently so it closes at episode end", () => {
    const first = setup(
      settings({ notifications: true, sounds: { waiting_permission: true, waiting_input: true } }),
    );
    first.set(snap("a", "waiting_permission", { state_since: 10 }));
    first.stop();
    tones.length = 0;
    closed.length = 0;
    const second = setup(
      settings({ notifications: true, sounds: { waiting_permission: true, waiting_input: true } }),
    );
    second.set(snap("a", "waiting_permission", { state_since: 10 }));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.options?.tag).toBe("sd-a-10");
    expect(calls[1]!.options?.silent).toBe(true);
    expect(tones).toEqual([]);
    // later updates in the same episode do not replace it again
    second.set(snap("a", "waiting_permission", { state_since: 10, last_event_at: 99 }));
    expect(calls).toHaveLength(2);
    second.set(snap("a", "working", { state_since: 20 }));
    expect(closed).toEqual(["sd-a-10"]);
  });

  it("does not re-create the notification after a reload when notifications are off", () => {
    const first = setup(settings({ notifications: true }));
    first.set(snap("a", "waiting_permission", { state_since: 10 }));
    first.stop();
    const second = setup(settings());
    second.set(snap("a", "waiting_permission", { state_since: 10 }));
    expect(calls).toHaveLength(1);
  });

  it("announces an episode that is new since the reload (state_since differs)", () => {
    const first = setup(settings({ notifications: true }));
    first.set(snap("a", "waiting_permission", { state_since: 10 }));
    first.stop();
    const second = setup(settings({ notifications: true }));
    second.set(snap("a", "waiting_permission", { state_since: 99 }));
    expect(calls).toHaveLength(2);
  });

  it("puts the tool name in the body for a permission prompt", () => {
    const s = snap("a", "waiting_permission", { session_name: "refactor", cwd: "/w/proj" });
    s.tracking = { last_tool: null, permission: { tool: "Bash" } } as never;
    expect(notificationText({ sessionId: "a", state: "waiting_permission", session: s })).toEqual({
      title: "proj needs permission",
      body: "refactor - Tool: Bash",
    });
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
    expect(t).toEqual({ title: "a needs input", body: "a" });
  });
});
