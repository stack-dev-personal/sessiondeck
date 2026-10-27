import { createSnapshot, type SessionSnapshot, type SessionState } from "@sessiondeck/contract";
import { describe, expect, it } from "vitest";
import { autoFit, autoFitMore, presetForCount } from "./autofit";
import { panesOf, validate } from "./spec";

const sess = (
  id: string,
  at: number,
  state: SessionState = "working",
  dir = `/w/${id}`,
): SessionSnapshot => ({
  ...createSnapshot({ session_id: id, host: "h", cwd: dir, ts: 1 }),
  project_dir: dir,
  state,
  last_event_at: at,
});

/** n live sessions s1..sn; s1 is the newest, so attention order is s1, s2, ... */
const live = (n: number) => Array.from({ length: n }, (_, i) => sess(`s${i + 1}`, 1000 - i));
const assigned = (spec: ReturnType<typeof autoFit>) =>
  panesOf(spec)
    .filter((p) => p.type === "session")
    .map((p) => p.sessionId ?? null);

// n live sessions -> [preset id, pane count, sessions per session pane in reading order]
const TABLE: [number, string, number, (string | null)[]][] = [
  [0, "strip", 1, []],
  [1, "solo", 2, ["s1"]],
  [2, "pair", 2, ["s1", "s2"]],
  [3, "focus", 4, ["s1", "s2", "s3", null]],
  [4, "quad", 4, ["s1", "s2", "s3", "s4"]],
  [5, "grid6", 6, ["s1", "s2", "s3", "s4", "s5", null]],
  [6, "grid6", 6, ["s1", "s2", "s3", "s4", "s5", "s6"]],
  [7, "grid6", 6, ["s1", "s2", "s3", "s4", "s5", "s6"]],
  [8, "grid6", 6, ["s1", "s2", "s3", "s4", "s5", "s6"]],
];

describe("autoFit by count (R6.2)", () => {
  it.each(TABLE)("%i live -> %s, %i panes", (n, preset, panes, who) => {
    const spec = autoFit(live(n), "count");
    expect(spec.id).toBe(preset);
    expect(panesOf(spec)).toHaveLength(panes);
    expect(assigned(spec)).toEqual(who);
    expect(validate(spec).ok).toBe(true);
    expect(presetForCount(n)).toBe(preset);
  });

  it("counts only live sessions: ended and exited are excluded", () => {
    const list = [
      ...live(2),
      sess("e1", 5000, "ended"),
      sess("x1", 6000, "exited"),
      sess("i1", 1, "idle"),
    ];
    const spec = autoFit(list, "count");
    expect(spec.id).toBe("focus");
    expect(assigned(spec)).toEqual(["s1", "s2", "i1", null]);
  });

  it("assigns in attention order: waiting first, then newest event", () => {
    const list = [
      sess("old", 10),
      sess("new", 900),
      sess("perm", 1, "waiting_permission"),
      sess("inp", 2, "waiting_input"),
    ];
    expect(assigned(autoFit(list, "count"))).toEqual(["inp", "perm", "new", "old"]);
    // Input order does not matter.
    expect(assigned(autoFit([...list].reverse(), "count"))).toEqual(["inp", "perm", "new", "old"]);
  });

  it("with more than six keeps the six most urgent and reports the rest", () => {
    const list = [...live(8), sess("urgent", 1, "waiting_permission")];
    const spec = autoFit(list, "count");
    expect(assigned(spec)[0]).toBe("urgent");
    expect(assigned(spec)).toHaveLength(6);
    expect(autoFitMore(list)).toBe(3);
    expect(autoFitMore(live(6))).toBe(0);
    expect(autoFitMore([...live(2), sess("e", 1, "ended")])).toBe(0);
  });

  it("never puts a session in two panes", () => {
    for (let n = 0; n <= 9; n++) {
      const ids = assigned(autoFit(live(n), "count")).filter((x) => x !== null);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("autoFit by project (R6.2)", () => {
  it("a column per project with a live session, most urgent first", () => {
    const list = [
      sess("a1", 10, "working", "/w/a"),
      sess("a2", 20, "working", "/w/a"),
      sess("b1", 5, "waiting_input", "/w/b"),
      sess("c1", 99, "ended", "/w/c"),
    ];
    const spec = autoFit(list, "project");
    expect(spec.id).toBe("by-project");
    expect(panesOf(spec).map((p) => p.projectDir)).toEqual(["/w/b", "/w/a"]);
  });
  it("with no live session it is one unassigned project pane", () => {
    const spec = autoFit([sess("e", 1, "ended")], "project");
    expect(panesOf(spec)).toHaveLength(1);
    expect(panesOf(spec)[0]).toMatchObject({ type: "project" });
    expect(panesOf(spec)[0]!.projectDir).toBeUndefined();
  });
});
