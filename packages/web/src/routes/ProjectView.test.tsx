import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAtlasApi } from "../atlas/api";
import { PROJECTS, detail, fakeApi, session } from "../atlas/fake";
import { useBoard } from "../store/board";
import { ProjectView } from "./ProjectView";
import { Projects } from "./Projects";

function mount(path = "/projects/p_a") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:id" element={<ProjectView />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => useBoard.setState({ sessions: {}, connection: "open" }));
afterEach(() => setAtlasApi(null));

describe("Projects list", () => {
  it("shows name, swatch, session count and live count", async () => {
    setAtlasApi(fakeApi());
    mount("/projects");
    const rows = await screen.findAllByTestId("project-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole("link", { name: "alpha" })).toHaveAttribute(
      "href",
      "/projects/p_a",
    );
    expect(rows[0]!.querySelector('[data-slot="sessions"]')).toHaveTextContent("30");
    expect(rows[0]!.querySelector('[data-slot="live"]')).toHaveTextContent("2");
    expect(rows[0]!.querySelector('[data-slot="swatch"]')).toHaveStyle({
      backgroundColor: "#3e63dd",
    });
    expect(rows[1]!.querySelector('[data-slot="swatch"]')).toHaveStyle({
      backgroundColor: "var(--state-idle)",
    });
    expect(screen.getByTestId("projects-count")).toHaveTextContent("2 projects");
  });

  it("virtualizes above 100 projects", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      ...PROJECTS[0]!,
      id: `p_${i}`,
      name: `proj-${String(i).padStart(3, "0")}`,
      live: 0,
    }));
    setAtlasApi(fakeApi({ listProjects: async () => many }));
    mount("/projects");
    await screen.findAllByTestId("project-row");
    expect(screen.getAllByTestId("project-row").length).toBeLessThan(40);
    expect(screen.getByTestId("projects-count")).toHaveTextContent("150 projects");
  });

  it("shows an error, not a blank page", async () => {
    setAtlasApi(
      fakeApi({
        listProjects: async () => {
          throw new Error("Token rejected");
        },
      }),
    );
    mount("/projects");
    expect(await screen.findByText(/Token rejected/)).toBeInTheDocument();
  });
});

describe("ProjectView", () => {
  it("renders every section with counts, totals formatted, branches and phases", async () => {
    setAtlasApi(fakeApi());
    mount();
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("alpha");
    await waitFor(() => expect(screen.getByTestId("totals")).toHaveTextContent("$1,234.50"));
    const totals = screen.getByTestId("totals");
    expect(totals.querySelector('[data-slot="sessions"]')).toHaveTextContent("27");
    expect(totals.querySelector('[data-slot="hours"]')).toHaveTextContent("12.3 h");
    expect(totals.querySelector('[data-slot="cost"]')).toHaveTextContent("$1,234.50");
    const ids = Array.from(document.querySelectorAll("[data-section]")).map((n) =>
      n.getAttribute("data-section"),
    );
    expect(ids).toEqual(["totals", "branches", "live", "archived", "phases"]);
    expect(screen.getByTestId("branches")).toHaveTextContent("feat/x");
    expect(
      screen.getAllByTestId("project-session").filter((r) => r.dataset["live"] === "true"),
    ).toHaveLength(2);
    await waitFor(() => expect(screen.getByTestId("phases")).toHaveTextContent("Hardening"));
    expect(document.querySelector('[data-section="phases"] [data-slot="count"]')).toHaveTextContent(
      "2",
    );
  });

  it("caps archived at 20 even if more arrive", async () => {
    setAtlasApi(fakeApi());
    mount();
    await screen.findByTestId("archived-list");
    const rows = within(screen.getByTestId("archived-list")).getAllByTestId("project-session");
    expect(rows).toHaveLength(20);
    expect(
      document.querySelector('[data-section="archived"] [data-slot="count"]'),
    ).toHaveTextContent("20");
  });

  it("shows the empty state for no archived sessions and n/a totals while loading", async () => {
    let release: (d: ReturnType<typeof detail>) => void = () => undefined;
    const api = fakeApi({ getProject: () => new Promise((r) => (release = r)) });
    setAtlasApi(api);
    mount();
    expect(screen.getByTestId("totals")).toHaveTextContent("n/a");
    await waitFor(() => expect(api.getProject).toHaveBeenCalled());
    await act(async () => release(detail({ archived: [] })));
    expect(await screen.findByText("No archived sessions yet.")).toBeInTheDocument();
    expect(screen.getByTestId("totals")).toHaveTextContent("$1,234.50");
  });

  it("renames the project inline: Enter saves, Escape cancels", async () => {
    const api = fakeApi();
    setAtlasApi(api);
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Project name: alpha/ }));
    await user.keyboard("{Control>}a{/Control}ignored{Escape}");
    expect(api.patchProject).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Project name: alpha/ }));
    await user.clear(screen.getByRole("textbox", { name: /Project name/ }));
    await user.keyboard("quant-edge{Enter}");
    await waitFor(() =>
      expect(api.patchProject).toHaveBeenCalledWith("p_a", { name: "quant-edge" }),
    );
  });

  it("refuses an empty project name", async () => {
    const api = fakeApi();
    setAtlasApi(api);
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Project name: alpha/ }));
    await user.clear(screen.getByRole("textbox", { name: /Project name/ }));
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Cannot be empty")).toBeInTheDocument();
    expect(api.patchProject).not.toHaveBeenCalled();
  });

  it("recolors with an allowed token or a valid #rrggbb, and rejects others", async () => {
    const api = fakeApi();
    setAtlasApi(api);
    mount();
    const user = userEvent.setup();
    const picker = await screen.findByTestId("color-picker");
    const select = within(picker).getByLabelText("Color");
    expect(
      Array.from(select.querySelectorAll("option"))
        .map((o) => o.value)
        .filter(Boolean),
    ).toContain("meter-high");
    await user.selectOptions(select, "state-error");
    await waitFor(() =>
      expect(api.patchProject).toHaveBeenCalledWith("p_a", { color: "state-error" }),
    );
    await user.type(within(picker).getByLabelText("or #rrggbb"), "red{Enter}");
    expect(within(picker).getByRole("alert")).toHaveTextContent("Use #rrggbb");
    expect(api.patchProject).toHaveBeenCalledTimes(1);
    await user.clear(within(picker).getByLabelText("or #rrggbb"));
    await user.type(within(picker).getByLabelText("or #rrggbb"), "#12ab9f{Enter}");
    await waitFor(() =>
      expect(api.patchProject).toHaveBeenLastCalledWith("p_a", { color: "#12ab9f" }),
    );
  });

  it("reassigns a session to another project, and clears the manual assignment", async () => {
    const api = fakeApi();
    setAtlasApi(api);
    useBoard.setState({ sessions: { s1: session("s1"), s2: session("s2") } });
    mount();
    const user = userEvent.setup();
    const row = (await screen.findAllByTestId("project-session")).find(
      (r) => r.dataset["sessionId"] === "s1",
    )!;
    const select = within(row).getByLabelText(/Move .* to project/);
    await user.selectOptions(select, "p_b");
    await waitFor(() => expect(api.setSessionProject).toHaveBeenCalledWith("s1", "p_b"));
    const row2 = screen
      .getAllByTestId("project-session")
      .find((r) => r.dataset["sessionId"] === "s2")!;
    await user.selectOptions(within(row2).getByLabelText(/Move .* to project/), "__infer__");
    await waitFor(() => expect(api.setSessionProject).toHaveBeenLastCalledWith("s2", null));
  });

  it("live rows follow the realtime board; a session moved away disappears", async () => {
    setAtlasApi(fakeApi());
    useBoard.setState({ sessions: { s1: session("s1"), s2: session("s2") } });
    mount();
    await screen.findAllByTestId("project-session");
    await act(async () => {
      useBoard.setState({
        sessions: {
          s1: session("s1"),
          s2: session("s2", { project_id: "p_b", project_name: "beta" }),
        },
      });
    });
    const live = screen
      .getAllByTestId("project-session")
      .filter((r) => r.dataset["live"] === "true");
    expect(live.map((r) => r.dataset["sessionId"])).toEqual(["s1"]);
  });

  it("phase chips on rows edit via PATCH", async () => {
    const api = fakeApi();
    setAtlasApi(api);
    mount();
    const user = userEvent.setup();
    const row = (await screen.findAllByTestId("project-session"))[0]!;
    await user.click(within(row).getByRole("button", { name: /Phase for/ }));
    await user.keyboard("Ship it{Enter}");
    await waitFor(() =>
      expect(api.setSessionPhase).toHaveBeenCalledWith(expect.any(String), "Ship it"),
    );
  });

  it("an unknown project shows the error and a way back", async () => {
    setAtlasApi(
      fakeApi({
        getProject: async () => {
          throw new Error("Not found");
        },
      }),
    );
    mount("/projects/nope");
    expect(await screen.findByRole("alert")).toHaveTextContent("Not found");
    expect(screen.getByRole("link", { name: "Back to Projects" })).toBeInTheDocument();
  });
});
