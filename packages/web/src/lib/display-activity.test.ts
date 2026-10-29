import { createSnapshot, type SessionSnapshot, type SessionState } from "@sessiondeck/contract";
import { describe, expect, it } from "vitest";
import {
  clampGraceSec,
  deriveDisplay,
  nextDeadline,
  sortDisplay,
  type TrackedMap,
} from "./display-activity";

const T0 = 1_000_000;
const snap = (id: string, state: SessionState, at = T0): SessionSnapshot =>
  ({
    ...createSnapshot({ session_id: id, host: "h", cwd: `/w/${id}`, ts: 1 }),
    state,
    state_since: at,
    last_event_at: at,
  }) as SessionSnapshot;

/** Feeds a sequence of [secondsFromT0, rawState] and records the displayed group per step. */
function run(grace: number, steps: Array<[number, SessionState]>) {
  let map: TrackedMap = new Map();
  const groups: string[] = [];
  const states: string[] = [];
  for (const [sec, st] of steps) {
    map = deriveDisplay(map, [snap("a", st, T0 + sec * 1000)], T0 + sec * 1000, grace * 1000);
    groups.push(map.get("a")!.group);
    states.push(map.get("a")!.displayState);
  }
  return { groups, states, map };
}
const changes = (g: string[]) => g.filter((x, i) => i > 0 && x !== g[i - 1]).length;

describe("display activity hysteresis (R3.10)", () => {
  it("Stop then UserPromptSubmit 30 s later never leaves the working group", () => {
    const { groups, states } = run(120, [
      [0, "working"],
      [1, "idle"],
      [15, "idle"],
      [31, "working"],
    ]);
    expect(new Set(groups)).toEqual(new Set(["working"]));
    expect(states[1]).toBe("working");
  });

  it("a session idle for 121 s moves exactly once", () => {
    const steps: Array<[number, SessionState]> = [[0, "working"]];
    for (let s = 1; s <= 130; s++) steps.push([s, "idle"]);
    const { groups, states } = run(120, steps);
    expect(changes(groups)).toBe(1);
    expect(states[120]).toBe("working"); // second 120 of idle is 119 s after Stop at 1
    expect(states[121]).toBe("idle");
    expect(groups[130]).toBe("idle");
  });

  it("waiting surfaces immediately, and ending the wait into idle starts the grace", () => {
    const { groups, states } = run(120, [
      [0, "working"],
      [5, "waiting_permission"],
      [6, "waiting_input"],
      [10, "idle"],
      [20, "idle"],
    ]);
    expect(groups.slice(0, 3)).toEqual(["working", "attention", "attention"]);
    expect(states[2]).toBe("waiting_input");
    expect(groups[3]).toBe("working");
    expect(groups[4]).toBe("working");
  });

  it("grace 0 behaves like the raw state", () => {
    const raw: SessionState[] = ["working", "idle", "working", "waiting_input", "idle", "error"];
    const { states } = run(
      0,
      raw.map((s, i) => [i, s]),
    );
    expect(states).toEqual(raw);
  });

  it("terminal states and first sightings show as they are", () => {
    expect(run(120, [[0, "idle"]]).states).toEqual(["working"]);
    expect(
      run(120, [
        [0, "working"],
        [1, "error"],
      ]).states,
    ).toEqual(["working", "error"]);
    expect(
      run(120, [
        [0, "working"],
        [1, "ended"],
      ]).states[1],
    ).toBe("ended");
  });

  it("an idle run interrupted by working restarts the grace", () => {
    const { groups } = run(60, [
      [0, "working"],
      [1, "idle"],
      [50, "working"],
      [51, "idle"],
      [100, "idle"],
      [110, "idle"],
      [111, "idle"],
    ]);
    expect(groups.slice(0, 6)).toEqual(Array(6).fill("working"));
    expect(groups[6]).toBe("idle");
  });

  it("reports the next deadline for the timer", () => {
    const { map } = run(120, [
      [0, "working"],
      [10, "idle"],
    ]);
    expect(nextDeadline(map, 120_000)).toBe(T0 + 130_000);
    expect(nextDeadline(new Map(), 120_000)).toBeNull();
  });
});

describe("stable order", () => {
  it("within-group order ignores last_event_at across repeated deltas", () => {
    let map: TrackedMap = new Map();
    const ids = ["a", "b", "c", "d"];
    const feed = (round: number) => {
      const list = ids.map((id, i) =>
        // Each round bumps a different session's last_event_at; state_since stays put.
        ({
          ...snap(id, "working", T0 + i),
          last_event_at: T0 + 1000 * (round + (i === round % 4 ? 10 : 0)),
        }),
      );
      map = deriveDisplay(map, list, T0 + 1000 * round, 120_000);
      return sortDisplay(list, map).map((s) => s.session_id);
    };
    const first = feed(0);
    for (let r = 1; r < 12; r++) expect(feed(r)).toEqual(first);
  });

  it("groups: attention, then working, then idle; newest entry first inside a group", () => {
    let map: TrackedMap = new Map();
    const list = [
      snap("i", "idle", T0),
      snap("w1", "working", T0 + 1),
      snap("w2", "working", T0 + 2),
      snap("p", "waiting_permission", T0),
    ];
    map = deriveDisplay(map, list, T0 + 10, 120_000);
    expect(sortDisplay(list, map).map((s) => s.session_id)).toEqual(["p", "w2", "w1", "i"]);
  });
});

describe("clampGraceSec", () => {
  it("clamps to 0..900, rounds, and defaults on junk", () => {
    expect(clampGraceSec(-5)).toBe(0);
    expect(clampGraceSec(10_000)).toBe(900);
    expect(clampGraceSec("45")).toBe(45);
    expect(clampGraceSec(12.6)).toBe(13);
    expect(clampGraceSec("abc")).toBe(120);
    expect(clampGraceSec(undefined)).toBe(120);
    expect(clampGraceSec(NaN)).toBe(120);
    expect(clampGraceSec("")).toBe(120);
  });

  it("a first sighting of a young idle is held from state_since; an old one shows idle", () => {
    const young = deriveDisplay(new Map(), [snap("a", "idle", T0 - 10_000)], T0, 120_000);
    expect(young.get("a")!.displayState).toBe("working");
    expect(nextDeadline(young, 120_000)).toBe(T0 - 10_000 + 120_000);
    const old = deriveDisplay(new Map(), [snap("a", "idle", T0 - 130_000)], T0, 120_000);
    expect(old.get("a")!.displayState).toBe("idle");
  });

  it("flapping working/waiting/idle: attention at once, waiting to idle held as working", () => {
    const { states, groups } = run(120, [
      [0, "working"],
      [5, "waiting_input"],
      [10, "idle"],
      [15, "waiting_input"],
      [20, "idle"],
    ]);
    expect(states).toEqual(["working", "waiting_input", "working", "waiting_input", "working"]);
    expect(groups).toEqual(["working", "attention", "working", "attention", "working"]);
  });

  it("a Stop/prompt flapper every 30 s never leaves working", () => {
    const steps: Array<[number, SessionState]> = [];
    for (let i = 0; i < 20; i++) steps.push([i * 30, i % 2 === 0 ? "working" : "idle"]);
    expect(new Set(run(120, steps).groups)).toEqual(new Set(["working"]));
  });
});
