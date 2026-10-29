import { act, render } from "@testing-library/react";
import { Profiler } from "react";
import { MemoryRouter } from "react-router-dom";
import { createSnapshot, type SessionSnapshot } from "@sessiondeck/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPreset } from "../layout/presets";
import { useBoard } from "../store/board";
import { useLayout } from "../store/layout";
import { Layout } from "./Layout";

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const sess = (i: number, at: number): SessionSnapshot => ({
  ...createSnapshot({ session_id: `s${i}`, host: "h", cwd: `/w/load-${i}`, ts: 1 }),
  project_dir: `/w/load-${i}`,
  last_event_at: at,
});

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

  it("the hidden-project note appears when a live project has no column", () => {
    useLayout.setState({ spec: buildPreset("by-project", ["/w/load-0"]) });
    const { queryByTestId } = render(
      <MemoryRouter initialEntries={["/layout"]}>
        <Layout />
      </MemoryRouter>,
    );
    expect(queryByTestId("projects-more")?.textContent).toContain("+5 more projects");
  });
});
