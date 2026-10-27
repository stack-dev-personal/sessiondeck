import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { setAtlasApi } from "../atlas/api";
import { fakeApi, session } from "../atlas/fake";
import { PhaseChip } from "./PhaseChip";

afterEach(() => setAtlasApi(null));

function setup(s = session("s1", { phase: "P3", phase_source: "inferred" })) {
  const api = fakeApi();
  setAtlasApi(api);
  render(<PhaseChip session={s} />);
  return api;
}

describe("PhaseChip", () => {
  it("shows the phase with its source in words", () => {
    setup();
    expect(screen.getByText("P3")).toBeInTheDocument();
    expect(screen.getByText("inferred")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Phase for name-s1: P3 \(inferred\)/ }),
    ).toBeInTheDocument();
  });

  it("shows manual and n/a", () => {
    const { unmount } = render(
      <PhaseChip session={session("s1", { phase: "Hardening", phase_source: "manual" })} />,
    );
    expect(screen.getByText("Hardening")).toBeInTheDocument();
    expect(screen.getByText("manual")).toBeInTheDocument();
    unmount();
    render(<PhaseChip session={session("s2")} />);
    expect(screen.getByText("n/a")).toBeInTheDocument();
    expect(screen.getByText("none")).toBeInTheDocument();
  });

  it("Enter saves through PATCH and returns focus to the chip", async () => {
    const api = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Phase for/ }));
    const input = screen.getByRole("textbox", { name: /Phase for/ });
    expect(input).toHaveFocus();
    await user.type(input, "Hardening{Enter}");
    await waitFor(() => expect(api.setSessionPhase).toHaveBeenCalledWith("s1", "Hardening"));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(screen.getByRole("button", { name: /Phase for/ })).toHaveFocus();
  });

  it("opens with Enter on the focused chip (keyboard only) and Escape cancels without a request", async () => {
    const api = setup();
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("button", { name: /Phase for/ })).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.keyboard("typed{Escape}");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(api.setSessionPhase).not.toHaveBeenCalled();
    expect(screen.getByText("P3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Phase for/ })).toHaveFocus();
  });

  it("an empty value on a manual label sends null (back to inferred)", async () => {
    const api = setup(session("s1", { phase: "Hardening", phase_source: "manual" }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Phase for/ }));
    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("Hardening");
    await user.clear(input);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(api.setSessionPhase).toHaveBeenCalledWith("s1", null));
  });

  it("an unchanged value sends nothing; a failed save stays open and says why", async () => {
    const api = setup(session("s1", { phase: "Hardening", phase_source: "manual" }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Phase for/ }));
    await user.keyboard("{Enter}");
    expect(api.setSessionPhase).not.toHaveBeenCalled();
    api.setSessionPhase.mockRejectedValueOnce(new Error("Hub unreachable"));
    await user.click(screen.getByRole("button", { name: /Phase for/ }));
    await user.type(screen.getByRole("textbox"), "x{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Hub unreachable");
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("renders hostile text as text", () => {
    render(
      <PhaseChip
        session={session("s1", { phase: "<img src=x onerror=alert(1)>", phase_source: "manual" })}
      />,
    );
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  });
});
