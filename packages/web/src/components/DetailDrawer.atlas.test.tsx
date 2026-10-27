import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../App";
import { setAtlasApi } from "../atlas/api";
import { fakeApi, session } from "../atlas/fake";
import { useBoard } from "../store/board";
import { useUi } from "../store/ui";
import { DetailDrawer } from "./DetailDrawer";

const NOW = Date.now();

function mount() {
  return render(
    <MemoryRouter initialEntries={["/board"]}>
      <App />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  useUi.setState({ compact: false, selectedSessionId: null });
  useBoard.setState({
    sessions: {
      s1: session("s1", { phase: "P3", phase_source: "inferred", started_at: NOW - 1000 }),
    },
    connection: "open",
  });
});
afterEach(() => setAtlasApi(null));

describe("card and drawer show the project", () => {
  it("card: hub project name in the where slot with its swatch; geometry slots unchanged", () => {
    mount();
    const card = screen.getByTestId("session-card");
    const where = card.querySelector('[data-slot="where"]')!;
    expect(where).toHaveTextContent("alpha · main");
    expect(where.querySelector('[data-slot="swatch"]')).toHaveStyle({ backgroundColor: "#3e63dd" });
    expect(card.style.height).toBe("var(--card-h)");
  });

  it("card without hub fields falls back to the directory name and has no swatch", () => {
    useBoard.setState({
      sessions: { s1: session("s1", { project_name: null, project_color: null }) },
    });
    mount();
    const where = screen.getByTestId("session-card").querySelector('[data-slot="where"]')!;
    expect(where).toHaveTextContent("s1 · main");
    expect(where.querySelector('[data-slot="swatch"]')).toBeNull();
  });

  it("drawer: project link, phase with source, Move select; Escape inside the editor keeps the drawer open", async () => {
    const api = fakeApi();
    setAtlasApi(api);
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("session-card"));
    const strip = within(await screen.findByTestId("drawer-atlas"));
    expect(strip.getByRole("link", { name: "alpha" })).toHaveAttribute("href", "/projects/p_a");
    expect(strip.getByText("inferred")).toBeInTheDocument();
    await user.click(strip.getByRole("button", { name: /Phase for/ }));
    await user.keyboard("Draft{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(api.setSessionPhase).not.toHaveBeenCalled();
    await user.click(strip.getByRole("button", { name: /Phase for/ }));
    await user.keyboard("Hardening{Enter}");
    await waitFor(() => expect(api.setSessionPhase).toHaveBeenCalledWith("s1", "Hardening"));
    await user.selectOptions(strip.getByLabelText(/Move .* to project/), "p_b");
    await waitFor(() => expect(api.setSessionProject).toHaveBeenCalledWith("s1", "p_b"));
    // The board follows the hub's WebSocket delta only; the PATCH response is not written into it
    // (it could be older than a delta that already arrived).
    expect(useBoard.getState().sessions["s1"]).not.toMatchObject({ project_id: "p_b" });
  });

  it("drawer without a router renders the project as plain text", () => {
    render(<DetailDrawer session={session("s1")} now={NOW} onClose={() => undefined} />);
    expect(within(screen.getByTestId("drawer-atlas")).queryByRole("link")).toBeNull();
    expect(
      within(screen.getByTestId("drawer-atlas")).getByTestId("project-link"),
    ).toHaveTextContent("alpha");
  });
});
