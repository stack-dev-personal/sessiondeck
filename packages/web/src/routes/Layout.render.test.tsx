import { act, render } from "@testing-library/react";
import { Profiler } from "react";
import { MemoryRouter } from "react-router-dom";
import { createSnapshot, type SessionSnapshot } from "@sessiondeck/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assignSession } from "../layout/ops";
import { buildPreset } from "../layout/presets";
import { panesOf } from "../layout/spec";
import { useBoard } from "../store/board";
import { useLayout } from "../store/layout";
import { Layout } from "./Layout";

// Per-pane commit counts: each session pane body is wrapped in its own Profiler.
const paneCommits = vi.hoisted(() => new Map<string, number>());
vi.mock("../components/layout/PaneBodies", async (orig) => {
  const real = await orig<typeof import("../components/layout/PaneBodies")>();
  const { Profiler: P, createElement } = await import("react");
  return {
    ...real,
    // Column bodies subscribe to every session by design; stubbed so only Layout itself is counted.
    ProjectPaneBody: () => null,
    SessionPaneBody: (props: { sessionId: string | undefined }) =>
      createElement(
        P,
        {
          id: props.sessionId ?? "empty",
          onRender: () =>
            paneCommits.set(
              props.sessionId ?? "empty",
              (paneCommits.get(props.sessionId ?? "empty") ?? 0) + 1,
            ),
        },
        createElement(real.SessionPaneBody, props),
      ),
  };
});

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const sess = (i: number, at: number, visible = true): SessionSnapshot => {
  const base = createSnapshot({ session_id: `s${i}`, host: "h", cwd: `/w/load-${i}`, ts: 1 });
  return {
    ...base,
    project_dir: `/w/load-${i}`,
    last_event_at: at,
    // A visible change per delta (the pane shows "ctx N%"), so the owner must commit once per delta.
    context: { ...base.context, used_pct: visible ? at : base.context.used_pct },
  };
};

describe("Layout re-renders (R6.4)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", RO);
    useLayout.setState({ spec: buildPreset("grid6") });
    useBoard.setState({
      sessions: Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => [`s${i}`, sess(i, 1)])),
      connection: "mock",
      loaded: true,
    });
  });

  it("deltas that reorder the projects do not re-render the layout route", () => {
    let commits = 0;
    render(
      <MemoryRouter initialEntries={["/layout"]}>
        <Profiler id="l" onRender={() => commits++}>
          <Layout />
        </Profiler>
      </MemoryRouter>,
    );
    const mounted = commits;
    // Round robin, as the load generator does: each delta moves its project to the front.
    for (let t = 0; t < 24; t++) {
      act(() => {
        useBoard.setState((st) => ({
          sessions: { ...st.sessions, [`s${t % 6}`]: sess(t % 6, 10 + t) },
        }));
      });
    }
    expect(commits).toBe(mounted);
  });

  it("with six filled panes a delta commits only the pane that owns it", () => {
    let spec = buildPreset("grid6");
    panesOf(spec)
      .filter((p) => p.type === "session")
      .forEach((p, i) => (spec = assignSession(spec, p.id, `s${i}`)));
    useLayout.setState({ spec });
    render(
      <MemoryRouter initialEntries={["/layout"]}>
        <Layout />
      </MemoryRouter>,
    );
    paneCommits.clear();
    for (let t = 0; t < 12; t++) {
      act(() => {
        useBoard.setState((st) => ({
          sessions: { ...st.sessions, [`s${t % 6}`]: sess(t % 6, 10 + t) },
        }));
      });
    }
    // Each pane owns two of the twelve deltas: exactly two commits each, none for others' deltas.
    expect(Object.fromEntries([...paneCommits].sort())).toEqual({
      s0: 2,
      s1: 2,
      s2: 2,
      s3: 2,
      s4: 2,
      s5: 2,
    });
  });

  it("the hidden-project note appears when a live project has no column", () => {
    useLayout.setState({ spec: buildPreset("by-project", ["/w/load-0"]) });
    const { queryByTestId } = render(
      <MemoryRouter initialEntries={["/layout"]}>
        <Layout />
      </MemoryRouter>,
    );
    expect(queryByTestId("projects-more")?.textContent).toContain("+5 more projects");
  });

  it("a project that arrives after mount updates the hidden count; plain deltas do not re-render", () => {
    useLayout.setState({ spec: buildPreset("by-project", ["/w/load-0"]) });
    let commits = 0;
    const { getByTestId } = render(
      <MemoryRouter initialEntries={["/layout"]}>
        <Profiler id="l" onRender={() => commits++}>
          <Layout />
        </Profiler>
      </MemoryRouter>,
    );
    expect(getByTestId("projects-more").textContent).toContain("+5 more projects");
    const mounted = commits;
    act(() => {
      useBoard.setState((st) => ({
        sessions: { ...st.sessions, s6: sess(6, 20) },
      }));
    });
    expect(getByTestId("projects-more").textContent).toContain("+6 more projects");
    const afterArrival = commits;
    expect(afterArrival).toBeGreaterThan(mounted);
    // Plain deltas (nothing visible changes) on projects with no column: count unchanged, no commit.
    for (let t = 0; t < 12; t++) {
      act(() => {
        useBoard.setState((st) => ({
          sessions: { ...st.sessions, [`s${1 + (t % 5)}`]: sess(1 + (t % 5), 30 + t, false) },
        }));
      });
    }
    expect(getByTestId("projects-more").textContent).toContain("+6 more projects");
    expect(commits).toBe(afterArrival);
  });
});
