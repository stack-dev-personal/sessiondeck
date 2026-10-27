import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAtlasApi } from "../atlas/api";
import { fakeApi, NOW, session } from "../atlas/fake";
import type { AtlasSession } from "../atlas/types";
import { DrawerHost } from "../components/DrawerHost";
import { applyListQuery, DEFAULT_QUERY, listQueryParams, parseListQuery } from "../lib/sessionList";
import { useBoard } from "../store/board";
import { DEFAULT_SETTINGS, useUi } from "../store/ui";
import { SessionList } from "./SessionList";

const ROWS: AtlasSession[] = [
  session("a1", {
    last_event_at: NOW - 1000,
    started_at: NOW - 9000,
    host: "h1",
    state: "working",
    phase: "P3",
  }),
  session("a2", {
    last_event_at: NOW - 2000,
    started_at: NOW - 8000,
    host: "h2",
    state: "idle",
    project_id: "p_b",
    project_name: "beta",
  }),
  session("a3", {
    last_event_at: NOW - 3000,
    started_at: NOW - 7000,
    host: "h1",
    state: "ended",
    phase: "Hardening",
  }),
  session("a4", {
    last_event_at: NOW - 40 * 86_400_000,
    started_at: NOW - 41 * 86_400_000,
    host: "h2",
    state: "ended",
  }),
];

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}

function mount(path = "/sessions", rows: AtlasSession[] = ROWS) {
  setAtlasApi(fakeApi({ listSessions: async () => rows }));
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/sessions" element={<SessionList />} />
      </Routes>
      <DrawerHost />
      <Where />
    </MemoryRouter>,
  );
}

const ids = () => screen.queryAllByTestId("session-list-row").map((r) => r.dataset["sessionId"]);
const selected = () =>
  screen.queryAllByTestId("session-list-row").find((r) => r.dataset["selected"] === "true");

beforeEach(() => {
  useUi.setState({
    settings: DEFAULT_SETTINGS,
    selectedSessionId: null,
    fallbackSession: null,
    paletteOpen: false,
  });
  useBoard.setState({ sessions: {}, connection: "open" });
});
afterEach(() => setAtlasApi(null));

describe("query helpers", () => {
  it("round-trips through URL params, omitting defaults", () => {
    expect(listQueryParams(DEFAULT_QUERY).toString()).toBe("");
    const q = parseListQuery(
      new URLSearchParams("host=h1&project=p_a&phase=P3&state=idle&range=7d&sort=state&q=x"),
    );
    expect(q).toMatchObject({
      host: "h1",
      project: "p_a",
      phase: "P3",
      state: "idle",
      range: "7d",
      sort: "state",
      q: "x",
    });
    expect(parseListQuery(listQueryParams(q))).toEqual(q);
    expect(parseListQuery(new URLSearchParams("state=bogus&range=1y&sort=zzz"))).toEqual(
      DEFAULT_QUERY,
    );
  });

  it("sorts by activity by default, then by started, project and state", () => {
    const ordered = (sort: "activity" | "started" | "project" | "state") =>
      applyListQuery(ROWS, { ...DEFAULT_QUERY, sort }, NOW).map((r) => r.session_id);
    expect(ordered("activity")).toEqual(["a1", "a2", "a3", "a4"]);
    expect(ordered("started")).toEqual(["a3", "a2", "a1", "a4"]);
    expect(ordered("project").at(-1)).toBe("a2"); // beta after alpha
  });
});

describe("session list", () => {
  it("lists hub sessions newest activity first, merged with the live board copy", async () => {
    useBoard.setState({
      sessions: {
        a1: { ...ROWS[0]!, state: "waiting_input" },
        live1: session("live1", { last_event_at: NOW }),
      },
    });
    mount();
    await waitFor(() => expect(ids()).toEqual(["live1", "a1", "a2", "a3", "a4"]));
    const a1 = screen.getAllByTestId("session-list-row")[1]!;
    expect(a1).toHaveTextContent("Needs input");
    expect(screen.getByTestId("sessions-count")).toHaveTextContent("5 of 5 sessions");
  });

  it("filters update the URL and the rows", async () => {
    mount();
    await waitFor(() => expect(ids()).toHaveLength(4));
    await userEvent.selectOptions(screen.getByLabelText("Host"), "h1");
    expect(ids()).toEqual(["a1", "a3"]);
    expect(screen.getByTestId("where")).toHaveTextContent("/sessions?host=h1");
    await userEvent.selectOptions(screen.getByLabelText("State"), "ended");
    expect(ids()).toEqual(["a3"]);
    await userEvent.selectOptions(screen.getByLabelText("Phase"), "Hardening");
    await userEvent.selectOptions(screen.getByLabelText("Sort"), "started");
    expect(screen.getByTestId("where").textContent).toBe(
      "/sessions?host=h1&phase=Hardening&state=ended&sort=started",
    );
    await userEvent.click(screen.getByRole("button", { name: /Clear filters/ }));
    expect(screen.getByTestId("where").textContent).toBe("/sessions?sort=started");
    expect(ids()).toHaveLength(4);
  });

  it("date range and project filters, and a URL that arrives pre-filtered", async () => {
    mount("/sessions?project=p_b");
    await waitFor(() => expect(ids()).toEqual(["a2"]));
    expect(screen.getByLabelText("Project")).toHaveValue("p_b");
    await userEvent.click(screen.getByRole("button", { name: /Clear filters/ }));
    await userEvent.selectOptions(screen.getByLabelText("Date"), "30d");
    expect(ids()).toEqual(["a1", "a2", "a3"]);
  });

  it("text filter narrows the list", async () => {
    mount();
    await waitFor(() => expect(ids()).toHaveLength(4));
    await userEvent.type(screen.getByLabelText(/Filter sessions by text/), "name-a2");
    expect(ids()).toEqual(["a2"]);
    expect(screen.getByTestId("where")).toHaveTextContent("q=name-a2");
  });

  it("j and k move the selection (clamped), Enter opens the drawer, Escape clears", async () => {
    mount();
    await waitFor(() => expect(ids()).toHaveLength(4));
    await userEvent.keyboard("j");
    expect(selected()?.dataset["sessionId"]).toBe("a1");
    expect(selected()).toHaveFocus();
    expect(selected()).toHaveAttribute("aria-current", "true");
    await userEvent.keyboard("jj");
    expect(selected()?.dataset["sessionId"]).toBe("a3");
    await userEvent.keyboard("k");
    expect(selected()?.dataset["sessionId"]).toBe("a2");
    await userEvent.keyboard("kkk");
    expect(selected()?.dataset["sessionId"]).toBe("a1");
    await userEvent.keyboard("{Enter}");
    expect(useUi.getState().selectedSessionId).toBe("a1");
    // a1 is not on the board: the drawer renders the hub copy.
    expect(await screen.findByTestId("detail-drawer")).toHaveAttribute("data-session-id", "a1");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("detail-drawer")).toBeNull();
    expect(selected()?.dataset["sessionId"]).toBe("a1");
    expect(selected()).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(selected()).toBeUndefined();
  });

  it("k with nothing selected goes to the last row", async () => {
    mount();
    await waitFor(() => expect(ids()).toHaveLength(4));
    await userEvent.keyboard("k");
    expect(selected()?.dataset["sessionId"]).toBe("a4");
  });

  it("keys are ignored while typing in the filter box or a select; / focuses the box", async () => {
    mount();
    await waitFor(() => expect(ids()).toHaveLength(4));
    const box = screen.getByLabelText(/Filter sessions by text/);
    await userEvent.keyboard("/");
    expect(box).toHaveFocus();
    expect(box).toHaveValue("");
    await userEvent.keyboard("jk");
    expect(box).toHaveValue("jk");
    expect(selected()).toBeUndefined();
    await userEvent.keyboard("{Escape}");
    expect(box).toHaveValue("");
    await userEvent.keyboard("{Escape}");
    expect(box).not.toHaveFocus();
    screen.getByLabelText("Host").focus();
    await userEvent.keyboard("j");
    expect(selected()).toBeUndefined();
  });

  it("?open=<id> selects that row, opens the drawer and drops the param", async () => {
    mount("/sessions?open=a3&host=h1");
    expect(await screen.findByTestId("detail-drawer")).toHaveAttribute("data-session-id", "a3");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/sessions?host=h1"));
    expect(selected()?.dataset["sessionId"]).toBe("a3");
  });

  it("?open=<id> survives a failed hub request: no not-found note, param kept", async () => {
    setAtlasApi(fakeApi({ listSessions: async () => Promise.reject(new Error("Hub error 500")) }));
    render(
      <MemoryRouter initialEntries={["/sessions?open=old1"]}>
        <SessionList />
        <Where />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("sessions-count")).toHaveTextContent("Hub error 500"),
    );
    expect(screen.getByTestId("sessions-count")).not.toHaveTextContent("not found");
    expect(screen.getByTestId("where").textContent).toBe("/sessions?open=old1");
  });

  it("notes when the hub returned exactly the 1000-row cap", async () => {
    const many = Array.from({ length: 1000 }, (_, i) =>
      session(`c${String(i).padStart(4, "0")}`, { last_event_at: NOW - i }),
    );
    mount("/sessions", many);
    await waitFor(() =>
      expect(screen.getByTestId("sessions-count")).toHaveTextContent(
        "showing newest 1000 stored sessions",
      ),
    );
  });

  it("virtualizes above 100 rows and still scrolls the selection into the window", async () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      session(`m${String(i).padStart(3, "0")}`, { last_event_at: NOW - i * 1000 }),
    );
    mount("/sessions", many);
    await waitFor(() => expect(ids().length).toBeGreaterThan(0));
    expect(ids().length).toBeLessThan(60);
    await userEvent.keyboard("k"); // last row
    await waitFor(() => expect(selected()?.dataset["sessionId"]).toBe("m299"));
    expect(
      within(screen.getByTestId("session-list")).getAllByTestId("session-list-row").length,
    ).toBeLessThan(60);
  });

  it("shows the hub error but keeps live sessions", async () => {
    setAtlasApi(
      fakeApi({ listSessions: async () => Promise.reject(new Error("Hub unreachable")) }),
    );
    useBoard.setState({ sessions: { live1: session("live1") } });
    render(
      <MemoryRouter initialEntries={["/sessions"]}>
        <SessionList />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("sessions-count")).toHaveTextContent("Hub unreachable"),
    );
    expect(ids()).toEqual(["live1"]);
    await act(async () => {});
  });
});

describe("hostile text", () => {
  it("renders a session name carrying markup as literal text", async () => {
    const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
    mount("/sessions", [session("x1", { session_name: evil, last_event_at: NOW })]);
    await waitFor(() => expect(ids()).toEqual(["x1"]));
    const row = screen.getByTestId("session-list-row");
    expect(row).toHaveTextContent(evil);
    expect(row.querySelector("img, script")).toBeNull();
  });
});
