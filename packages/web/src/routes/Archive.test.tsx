import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAtlasApi } from "../atlas/api";
import { detail, fakeApi, NOW, session } from "../atlas/fake";
import { isLive, mergeLive } from "../atlas/live";
import {
  archiveOf,
  carryAtlas,
  isArchivedState,
  outcomeExcerpt,
  type AtlasSession,
} from "../atlas/types";
import { branchOf } from "../components/ArchiveSummary";
import { DrawerHost } from "../components/DrawerHost";
import { mergeSessions } from "../lib/sessionList";
import { ProjectView } from "./ProjectView";
import { SessionList } from "./SessionList";
import { useBoard } from "../store/board";
import { useUi } from "../store/ui";

const RLO = String.fromCodePoint(0x202e);
const PDF = String.fromCodePoint(0x202c);
const ZWSP = String.fromCodePoint(0x200b);
const C1 = String.fromCodePoint(0x85);

function archived(
  id: string,
  over: Record<string, unknown> = {},
  snap: Partial<AtlasSession> = {},
) {
  return session(id, {
    state: "ended",
    session_name: null,
    ...snap,
    archive: {
      source: { root_label: "vault", rel_path: "projects/a/sessions/x.md", mtime_ms: 1, size: 1 },
      collection: "projects/a",
      title: "Spool compaction",
      date: "2026-09-05",
      started_at: null,
      ended_at: null,
      duration_s: 2700,
      project_dir: null,
      branch: "feat/spool",
      tools_used: [{ name: "Read", count: 3 }],
      commits: ["c0ffee1 Compact on size", "beef002 Trim"],
      prs: ["#7 Spool"],
      outcome: "Spool compacts at 4 MB.",
      outcome_truncated: false,
      ...over,
    },
  });
}

describe("archiveOf", () => {
  it("is null without a record and tolerates garbage", () => {
    expect(archiveOf(session("x"))).toBeNull();
    expect(archiveOf({ ...session("x"), archive: "nope" } as AtlasSession)).toBeNull();
    const a = archiveOf({
      ...session("x"),
      archive: { commits: [1, "ok"], tools_used: [{}, null] },
    } as AtlasSession);
    expect(a).toMatchObject({
      title: null,
      outcome: "",
      commits: ["ok"],
      tools: [],
      durationS: null,
    });
  });

  it("neutralizes title, outcome, branch, commits, prs and tool names", () => {
    const s = archived("x", {
      title: `T${RLO}x`,
      outcome: `o${ZWSP}k ${C1}`,
      branch: `b${RLO}r`,
      commits: [`c${PDF}1`],
      prs: [`#1${ZWSP}`],
      tools_used: [{ name: `Re${ZWSP}ad`, count: 1 }],
    });
    const a = archiveOf(s)!;
    expect(a.title).toBe("T<U+202E>x");
    expect(a.outcome).toBe("o<U+200B>k <U+0085>");
    expect(a.branch).toBe("b<U+202E>r");
    expect(a.commits).toEqual(["c<U+202C>1"]);
    expect(a.prs).toEqual(["#1<U+200B>"]);
    expect(a.tools[0]!.name).toBe("Re<U+200B>ad");
  });

  it("isArchivedState needs a record and a non-live state", () => {
    expect(isArchivedState(archived("x"))).toBe(true);
    expect(isArchivedState(archived("x", {}, { state: "idle" }))).toBe(false);
    expect(isArchivedState(session("x", { state: "ended" }))).toBe(false);
  });

  it("branchOf prefers the live branch, falls back to the capture's, neutralized", () => {
    const none = { branch: null, worktree: null, pr: null };
    expect(branchOf(archived("x", {}, { git: none }))).toBe("feat/spool");
    expect(branchOf(archived("x", {}, { git: { ...none, branch: "live" } }))).toBe("live");
    expect(branchOf(archived("x", { branch: `b${RLO}` }, { git: none }))).toBe("b<U+202E>");
    expect(branchOf(session("x", { git: none }))).toBeNull();
  });

  it("outcomeExcerpt collapses whitespace and cuts", () => {
    expect(outcomeExcerpt("a\n\n b   c")).toBe("a b c");
    expect(outcomeExcerpt("x".repeat(300), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("merging", () => {
  it("a board copy without archive keeps the REST record", () => {
    const rest = archived("m1");
    const board = session("m1", { state: "ended" });
    const out = mergeSessions([rest], { m1: board });
    expect(out).toHaveLength(1);
    expect(archiveOf(out[0]!)?.title).toBe("Spool compaction");
    expect(carryAtlas(board, rest)).toHaveProperty("archive");
  });

  it("an archived session is not live even inside the grace period, and not duplicated", () => {
    const s = archived("m1", {}, { state_since: NOW - 1000, last_event_at: NOW - 1000 });
    expect(isLive(s, NOW)).toBe(false);
    expect(mergeLive([], { m1: s }, "p_a", NOW)).toEqual([]);
  });
});

describe("ProjectView archived rows", () => {
  beforeEach(() => useBoard.setState({ sessions: {}, connection: "open" }));
  afterEach(() => setAtlasApi(null));

  function mount(d = detail()) {
    setAtlasApi(fakeApi({ getProject: async () => d }));
    return render(
      <MemoryRouter initialEntries={["/projects/p_a"]}>
        <Routes>
          <Route path="/projects/:id" element={<ProjectView />} />
        </Routes>
        <DrawerHost />
      </MemoryRouter>,
    );
  }

  it("one row per merged session with archive fields, marked Archived; no duplicates", async () => {
    const merged = archived(
      "m1",
      { title: `Plain ${RLO}title` },
      { session_name: "live name", git: { branch: "feat/x", worktree: null, pr: null } },
    );
    const only = archived("o1", {}, { session_name: "Spool compaction" });
    const d = detail({ live: [session("s1")], archived: [merged, only, merged] });
    mount(d);
    const list = await screen.findByTestId("archived-list");
    const rows = within(list).getAllByTestId("project-session");
    expect(rows).toHaveLength(2);
    const r = rows[0]!;
    expect(r).toHaveAttribute("data-archived", "true");
    expect(r).toHaveTextContent("live name");
    expect(r).toHaveTextContent("feat/x");
    expect(r.querySelector('[data-slot="archived-badge"]')).toHaveTextContent("Archived");
    expect(r.querySelector('[data-slot="duration"]')).toHaveTextContent("45m");
    expect(r.querySelector('[data-slot="commits"]')).toHaveTextContent("2 commits");
    expect(r.querySelector('[data-slot="prs"]')).toHaveTextContent("1 PR");
    expect(r.querySelector('[data-slot="outcome"]')).toHaveTextContent("Spool compacts at 4 MB.");
    expect(r.textContent).toContain("Plain <U+202E>title");
    expect(r.textContent).not.toContain(RLO);
    // Archived-only: no live fields.
    expect(rows[1]).toHaveTextContent("Spool compaction");
  });

  it("a session in both lists is shown once, as live", async () => {
    const s = archived("dup", {}, { state: "idle" });
    mount(detail({ live: [s], archived: [{ ...s, state: "ended" } as AtlasSession] }));
    await screen.findByTestId("live-list");
    expect(
      screen
        .getAllByTestId("project-session")
        .filter((e) => e.getAttribute("data-session-id") === "dup"),
    ).toHaveLength(1);
  });

  it("an archived row opens the drawer with the archive section", async () => {
    const only = archived("o1", { outcome: `kestrel ${RLO}done` });
    mount(detail({ archived: [only] }));
    const list = await screen.findByTestId("archived-list");
    await userEvent.click(within(list).getByRole("button", { name: /Spool compaction/ }));
    const dlg = await screen.findByTestId("detail-drawer");
    const out = within(dlg).getByText(/kestrel/);
    expect(out).toHaveTextContent("kestrel <U+202E>done");
    act(() => useUi.getState().closeSession());
  });
});

describe("SessionList archived rows", () => {
  beforeEach(() => useBoard.setState({ sessions: {}, connection: "open" }));
  afterEach(() => setAtlasApi(null));

  it("shows the archive line on one merged row", async () => {
    const rows = [archived("m1"), archived("m1")];
    setAtlasApi(fakeApi({ listSessions: async () => rows }));
    render(
      <MemoryRouter initialEntries={["/sessions"]}>
        <Routes>
          <Route path="/sessions" element={<SessionList />} />
        </Routes>
      </MemoryRouter>,
    );
    const row = await screen.findByTestId("session-list-row");
    expect(screen.getAllByTestId("session-list-row")).toHaveLength(1);
    expect(row).toHaveAttribute("data-archived", "true");
    expect(row.querySelector('[data-slot="state"]')).toHaveTextContent("Archived");
    expect(row.querySelector('[data-slot="outcome"]')).toHaveTextContent("Spool compacts at 4 MB.");
    expect(row.querySelector('[data-slot="commits"]')).toHaveTextContent("2 commits");
  });
});
