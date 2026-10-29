import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SESSION_STATES } from "@sessiondeck/contract";
import { STATE_VOCAB } from "../lib/state-vocab";
import { App } from "../App";
import DevCards from "./DevCards";

const EXPECTED = [
  ...SESSION_STATES.map((s) => `specimen-state-${s}`),
  ...SESSION_STATES.map((s) => `specimen-state-${s}-compact`),
  ...[59, 60, 80, 81].map((p) => `specimen-meter-ctx-${p}`),
  "specimen-all-null",
  "specimen-populated",
  "specimen-over-200k",
  "specimen-subagents-12",
  "specimen-long-name",
];

describe("/dev/cards", () => {
  it("renders every named specimen", () => {
    render(
      <MemoryRouter>
        <DevCards />
      </MemoryRouter>,
    );
    for (const id of EXPECTED) expect(screen.getByTestId(id), id).toBeInTheDocument();
  });

  it("shows glyph and label for every state, full and compact", () => {
    render(
      <MemoryRouter>
        <DevCards />
      </MemoryRouter>,
    );
    for (const st of SESSION_STATES) {
      for (const id of [`specimen-state-${st}`, `specimen-state-${st}-compact`]) {
        const el = screen.getByTestId(id);
        expect(el).toHaveTextContent(STATE_VOCAB[st].glyph);
        expect(el).toHaveTextContent(STATE_VOCAB[st].label);
      }
    }
  });

  it("all-null and populated cards use the same slots and show n/a for nulls", () => {
    render(
      <MemoryRouter>
        <DevCards />
      </MemoryRouter>,
    );
    const slots = (id: string) =>
      Array.from(screen.getByTestId(id).querySelectorAll("[data-slot]")).map((n) =>
        n.getAttribute("data-slot"),
      );
    expect(slots("specimen-all-null")).toEqual(slots("specimen-populated"));
    expect(screen.getByTestId("specimen-all-null").textContent).toContain("n/a");
  });

  it("is routed at /dev/cards", async () => {
    render(
      <MemoryRouter initialEntries={["/dev/cards"]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("dev-cards")).toBeInTheDocument();
  });
});
