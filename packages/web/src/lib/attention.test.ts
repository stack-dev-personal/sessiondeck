// @vitest-environment node
import { createSnapshot, type SessionSnapshot, type SessionState } from "@sessiondeck/contract";
import { describe, expect, it } from "vitest";
import {
  applyFilters,
  displayNameOf,
  projectOf,
  selectProjects,
  sortForAttention,
} from "./attention";

export function snap(
  id: string,
  state: SessionState,
  lastEvent: number,
  over: Partial<SessionSnapshot> = {},
): SessionSnapshot {
  return {
    ...createSnapshot({ session_id: id, host: "h1", cwd: `/w/${id}`, ts: 1 }),
    state,
    last_event_at: lastEvent,
    ...over,
  };
}

const ids = (l: SessionSnapshot[]) => l.map((s) => s.session_id);

describe("sortForAttention", () => {
  it("puts waiting_permission and waiting_input first, then newest event first", () => {
    const out = sortForAttention([
      snap("a", "working", 500),
      snap("b", "idle", 900),
      snap("c", "waiting_input", 100),
      snap("d", "waiting_permission", 50),
      snap("e", "working", 700),
    ]);
    expect(ids(out)).toEqual(["c", "d", "b", "e", "a"]);
  });

  it("orders inside the attention group by last event too", () => {
    const out = sortForAttention([
      snap("a", "waiting_input", 10),
      snap("b", "waiting_permission", 20),
    ]);
    expect(ids(out)).toEqual(["b", "a"]);
  });

  it("breaks ties by session_id and does not depend on input order", () => {
    const l = [snap("z", "idle", 5), snap("m", "idle", 5), snap("a", "idle", 5)];
    expect(ids(sortForAttention(l))).toEqual(["a", "m", "z"]);
    expect(ids(sortForAttention([...l].reverse()))).toEqual(["a", "m", "z"]);
  });

  it("does not mutate its input", () => {
    const l = [snap("a", "idle", 1), snap("b", "waiting_input", 0)];
    sortForAttention(l);
    expect(ids(l)).toEqual(["a", "b"]);
  });

  it("treats error, ended and exited as ordinary states", () => {
    const out = sortForAttention([snap("a", "error", 9), snap("b", "waiting_input", 1)]);
    expect(ids(out)).toEqual(["b", "a"]);
  });
});

describe("project and filters", () => {
  const l = [
    snap("a", "idle", 1, { host: "h1", project_dir: "/home/x/alpha" }),
    snap("b", "idle", 2, { host: "h2", project_dir: null, cwd: "C:\\w\\beta" }),
    snap("c", "idle", 3, { host: "h2", project_dir: "/home/x/alpha" }),
  ];
  it("derives the project from project_dir, else the cwd basename", () => {
    expect(projectOf(l[0]!)).toBe("alpha");
    expect(projectOf(l[1]!)).toBe("beta");
    expect(displayNameOf({ ...l[0]!, session_name: "fix bug" })).toBe("fix bug");
    expect(displayNameOf(l[0]!)).toBe("alpha");
  });
  it("filters by host, project, both, and neither", () => {
    expect(ids(applyFilters(l, { host: null, project: null }))).toEqual(["a", "b", "c"]);
    expect(ids(applyFilters(l, { host: "h2", project: null }))).toEqual(["b", "c"]);
    expect(ids(applyFilters(l, { host: null, project: "alpha" }))).toEqual(["a", "c"]);
    expect(ids(applyFilters(l, { host: "h2", project: "alpha" }))).toEqual(["c"]);
    expect(applyFilters(l, { host: "nope", project: null })).toEqual([]);
  });
  it("lists distinct projects sorted", () => {
    expect(selectProjects(Object.fromEntries(l.map((s) => [s.session_id, s])))).toEqual([
      "alpha",
      "beta",
    ]);
  });
});
