import { describe, expect, it } from "vitest";
import { assignSession, sessionPaneOf, setPaneCompact, setRatiosAt, unassignPane } from "./ops";
import { buildPreset, PRESET_NAMES } from "./presets";
import { panesOf, validate, type LayoutSpec } from "./spec";

describe("layout ops", () => {
  it("setRatiosAt replaces only the addressed split and leaves the input untouched", () => {
    const spec = buildPreset("quad");
    const before = JSON.stringify(spec);
    const next = setRatiosAt(spec, [1], [0.3, 0.7]);
    expect(JSON.stringify(spec)).toBe(before);
    const root = next.root;
    expect(root.kind === "split" && root.children[1]).toMatchObject({ ratios: [0.3, 0.7] });
    expect(root.kind === "split" && root.children[0]).toMatchObject({ ratios: [0.5, 0.5] });
  });
  it("ignores a path that is missing or has the wrong arity", () => {
    const spec = buildPreset("quad");
    expect(setRatiosAt(spec, [5], [0.5, 0.5])).toBe(spec);
    expect(setRatiosAt(spec, [], [0.2, 0.3, 0.5])).toBe(spec);
  });
  it("setPaneCompact toggles one pane and is a no-op when unchanged", () => {
    const spec = buildPreset("pair");
    const next = setPaneCompact(spec, "p0", true);
    expect(panesOf(next).map((p) => p.compact)).toEqual([true, undefined]);
    expect(setPaneCompact(next, "p0", true)).toBe(next);
    expect(panesOf(setPaneCompact(next, "p0", false))[0]).toEqual(panesOf(spec)[0]);
  });
});

const sessionIds = (s: LayoutSpec) => panesOf(s).map((p) => p.sessionId ?? null);

describe("assignSession (R6.6)", () => {
  it("assigns into an empty session pane", () => {
    const next = assignSession(buildPreset("pair"), "p1", "A");
    expect(sessionIds(next)).toEqual([null, "A"]);
  });
  it("moves a session: the old pane becomes unassigned", () => {
    let s = assignSession(buildPreset("pair"), "p0", "A");
    s = assignSession(s, "p1", "A");
    expect(sessionIds(s)).toEqual([null, "A"]);
    expect(sessionPaneOf(s, "A")?.id).toBe("p1");
  });
  it("swaps when the target holds another session", () => {
    let s = assignSession(buildPreset("pair"), "p0", "A");
    s = assignSession(s, "p1", "B");
    s = assignSession(s, "p1", "A");
    expect(sessionIds(s)).toEqual(["B", "A"]);
  });
  it("replaces the occupant when the session came from no pane", () => {
    let s = assignSession(buildPreset("pair"), "p0", "A");
    s = assignSession(s, "p0", "C");
    expect(sessionIds(s)).toEqual(["C", null]);
  });
  it("ignores non-session panes, unknown panes and the same assignment", () => {
    const solo = buildPreset("solo");
    expect(assignSession(solo, "p0", "A")).toBe(solo); // p0 is the board pane
    expect(assignSession(solo, "nope", "A")).toBe(solo);
    const s = assignSession(solo, "p1", "A");
    expect(assignSession(s, "p1", "A")).toBe(s);
  });
  it("unassignPane empties a session pane only", () => {
    const s = assignSession(buildPreset("solo"), "p1", "A");
    expect(sessionIds(unassignPane(s, "p1"))).toEqual([null, null]);
    expect(unassignPane(s, "p0")).toBe(s);
  });
  it("collapses duplicates in a stored spec", () => {
    const dup = JSON.parse(JSON.stringify(buildPreset("quad"))) as LayoutSpec;
    for (const p of panesOf(dup)) p.sessionId = "A";
    const s = assignSession(dup, "p2", "A");
    expect(sessionIds(s).filter((x) => x === "A")).toHaveLength(1);
  });

  it("property: any sequence of assign, unassign and preset switches keeps a session in at most one pane", () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % n;
    };
    const sessions = ["A", "B", "C", "D", "E", "F", "G", "H"];
    for (let run = 0; run < 40; run++) {
      let spec = buildPreset(PRESET_NAMES[rnd(PRESET_NAMES.length)]!, ["/a", "/b", "/c"]);
      for (let step = 0; step < 60; step++) {
        const panes = panesOf(spec);
        const op = rnd(10);
        if (op < 6) {
          spec = assignSession(spec, panes[rnd(panes.length)]!.id, sessions[rnd(sessions.length)]!);
        } else if (op < 8) {
          spec = unassignPane(spec, panes[rnd(panes.length)]!.id);
        } else if (op === 8) {
          // drag a placed session onto another pane (swap or move)
          const held = panes.filter((p) => p.sessionId !== undefined);
          if (held.length > 0)
            spec = assignSession(
              spec,
              panes[rnd(panes.length)]!.id,
              held[rnd(held.length)]!.sessionId!,
            );
        } else {
          // Switching preset carries the assignments over by pane order in the real flow; here a
          // fresh preset must also satisfy the invariant, and so must the old assignments reapplied.
          const before = panes.map((p) => p.sessionId).filter((x): x is string => !!x);
          spec = buildPreset(PRESET_NAMES[rnd(PRESET_NAMES.length)]!, ["/a", "/b"]);
          for (const id of before) {
            const open = panesOf(spec).find((p) => p.type === "session" && !p.sessionId);
            if (open) spec = assignSession(spec, open.id, id);
          }
        }
        const held = panesOf(spec)
          .filter((p) => p.type === "session" && p.sessionId !== undefined)
          .map((p) => p.sessionId);
        expect(new Set(held).size).toBe(held.length);
        expect(validate(spec).ok).toBe(true);
      }
    }
  });
});
