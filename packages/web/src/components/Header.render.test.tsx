import { createSnapshot } from "@sessiondeck/contract";
import { act, render } from "@testing-library/react";
import { Profiler } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { useBoard } from "../store/board";
import { Header } from "./Header";

describe("Header re-renders (R6.4)", () => {
  beforeEach(() => {
    useBoard.getState().replaceAll([
      createSnapshot({ session_id: "a", host: "h1", cwd: "/w/a", ts: 1 }),
      createSnapshot({ session_id: "b", host: "h1", cwd: "/w/b", ts: 1 }),
    ]);
  });

  it("a delta that adds no host does not re-render it; a new host does", () => {
    let commits = 0;
    render(
      <MemoryRouter>
        <Profiler id="h" onRender={() => commits++}>
          <Header />
        </Profiler>
      </MemoryRouter>,
    );
    const mounted = commits;
    act(() => {
      useBoard.setState((st) => ({
        sessions: {
          ...st.sessions,
          a: createSnapshot({ session_id: "a", host: "h1", cwd: "/w/a", ts: 2 }),
        },
      }));
    });
    expect(commits).toBe(mounted);
    act(() => {
      useBoard.setState((st) => ({
        sessions: {
          ...st.sessions,
          c: createSnapshot({ session_id: "c", host: "h2", cwd: "/w/c", ts: 3 }),
        },
      }));
    });
    expect(commits).toBeGreaterThan(mounted);
  });
});
