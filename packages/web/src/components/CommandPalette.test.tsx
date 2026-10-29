import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAtlasApi } from "../atlas/api";
import { fakeApi, session } from "../atlas/fake";
import type { SearchResponse, SearchResult } from "../atlas/types";
import { useBoard } from "../store/board";
import { DEFAULT_SETTINGS, useUi } from "../store/ui";
import { CommandPalette, SEARCH_DEBOUNCE_MS, closePalette } from "./CommandPalette";

const hit = (over: Partial<SearchResult> & Pick<SearchResult, "kind" | "id">): SearchResult => ({
  project_id: "p_a",
  title: over.id,
  snippet: "",
  score: 1,
  ...over,
});

const RESULTS: SearchResult[] = [
  hit({ kind: "phase", id: "Hardening", project_id: "p_b", title: "Hardening" }),
  hit({ kind: "project", id: "p_a", title: "alpha" }),
  hit({
    kind: "session",
    id: "s-1",
    title: "Fix the alpha bug",
    snippet: "alpha stack trace",
    state: "working",
  }),
  hit({ kind: "session", id: "s-2", title: "Second alpha", state: "idle" }),
];
const ok = (results: SearchResult[]): SearchResponse => ({ results, took_ms: 1 });

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}

function mount() {
  return render(
    <MemoryRouter initialEntries={["/board"]}>
      <button>before</button>
      <input aria-label="other box" />
      <CommandPalette />
      <Where />
    </MemoryRouter>,
  );
}

const dialog = () => screen.getByRole("dialog");

beforeEach(() => {
  useUi.setState({ settings: DEFAULT_SETTINGS, selectedSessionId: null, paletteOpen: false });
  useBoard.setState({ sessions: {}, connection: "open" });
});
afterEach(() => {
  closePalette();
  setAtlasApi(null);
});

describe("open and close", () => {
  it("Ctrl+K and Meta+K open a modal combobox dialog with the input focused", async () => {
    setAtlasApi(fakeApi({ search: vi.fn(async () => ok(RESULTS)) }));
    mount();
    for (const mod of ["Control", "Meta"] as const) {
      await userEvent.keyboard(`{${mod}>}k{/${mod}}`);
      const d = dialog();
      expect(d).toHaveAttribute("aria-modal", "true");
      const input = screen.getByRole("combobox");
      expect(input).toHaveFocus();
      expect(input).toHaveAttribute("aria-controls", screen.getByRole("listbox").id);
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).toBeNull();
    }
  });

  it("opens while typing in another input, and Escape returns focus there", async () => {
    setAtlasApi(fakeApi());
    mount();
    const other = screen.getByLabelText("other box");
    other.focus();
    await userEvent.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("combobox")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(other).toHaveFocus();
  });

  it("Escape restores focus to a non-text control; Tab keeps focus in the dialog", async () => {
    setAtlasApi(fakeApi());
    mount();
    const btn = screen.getByRole("button", { name: "before" });
    btn.focus();
    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.tab();
    expect(screen.getByRole("combobox")).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("combobox")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(btn).toHaveFocus();
  });

  it("board shortcuts (t) do not fire while it is open", async () => {
    setAtlasApi(fakeApi());
    mount();
    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.keyboard("t");
    expect(screen.getByRole("combobox")).toHaveValue("t");
    expect(useUi.getState().paletteOpen).toBe(true);
  });
});

describe("results", () => {
  it("empty query shows recent items, grouped as Sessions, Projects, Phases with kind labels", async () => {
    const search = vi.fn(async () => ok(RESULTS));
    setAtlasApi(fakeApi({ search }));
    mount();
    await userEvent.keyboard("{Control>}k{/Control}");
    await screen.findAllByRole("option");
    expect(search).toHaveBeenCalledWith("", expect.objectContaining({ limit: 20 }));
    const groups = screen.getAllByRole("group").map((g) => g.textContent ?? "");
    expect(groups[0]).toMatch(/^▶ Sessions · 2/);
    expect(groups[1]).toMatch(/Projects/);
    expect(groups[2]).toMatch(/Phases/);
    expect(screen.getAllByRole("option").map((o) => o.dataset["kind"])).toEqual([
      "session",
      "session",
      "project",
      "phase",
    ]);
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Session");
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Working");
  });

  it("shows No results and an error state", async () => {
    const search = vi
      .fn<() => Promise<SearchResponse>>()
      .mockResolvedValueOnce(ok([]))
      .mockRejectedValueOnce(new Error("Hub unreachable"));
    setAtlasApi(fakeApi({ search }));
    mount();
    await userEvent.keyboard("{Control>}k{/Control}");
    await waitFor(() =>
      expect(screen.getByTestId("palette-status")).toHaveTextContent("No results"),
    );
    await userEvent.keyboard("zzz");
    expect(await screen.findByRole("alert")).toHaveTextContent("Search failed: Hub unreachable");
  });

  it("held Enter then a failed search opens nothing; Enter again retries and opens the first hit", async () => {
    vi.useFakeTimers();
    const fresh = [hit({ kind: "session", id: "quokka-1", title: "quokka work" })];
    let fail = true;
    const search = vi.fn(async (q: string) => {
      if (q === "quokka") {
        if (fail) throw new Error("Hub unreachable");
        return ok(fresh);
      }
      return ok(RESULTS);
    });
    setAtlasApi(fakeApi({ search }));
    mount();
    await act(async () => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "quokka" } });
    fireEvent.keyDown(input, { key: "Enter" }); // held while the search is pending
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 10);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Press Enter to retry");
    expect(screen.getByTestId("where").textContent).toBe("/board");
    fail = false;
    fireEvent.keyDown(input, { key: "Enter" }); // retry
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 10);
    });
    expect(screen.getByTestId("where").textContent).toBe("/board"); // the held Enter did not survive the error
    expect(screen.getByRole("option")).toHaveTextContent("quokka work");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("where").textContent).toBe("/sessions?open=quokka-1");
  });

  it("renders a hostile title and snippet as literal text, never as markup", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    setAtlasApi(
      fakeApi({
        search: vi.fn(async () =>
          ok([hit({ kind: "session", id: "s-9", title: evil, snippet: `<b>bold</b> ${evil}` })]),
        ),
      }),
    );
    const { container } = mount();
    await userEvent.keyboard("{Control>}k{/Control}");
    const opt = await screen.findByRole("option");
    expect(opt).toHaveTextContent(evil);
    expect(opt.textContent).toContain("<b>bold</b>");
    expect(document.body.querySelector("img")).toBeNull();
    expect(document.body.querySelector("b")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
  });

  it("highlights matches client-side with <mark> over text nodes", async () => {
    setAtlasApi(fakeApi({ search: vi.fn(async () => ok([RESULTS[2]!])) }));
    mount();
    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.keyboard("alpha");
    await waitFor(() => expect(dialog()).toHaveAttribute("data-results-for", "alpha"));
    const marks = Array.from(dialog().querySelectorAll("mark")).map((m) => m.textContent);
    expect(marks).toEqual(["alpha", "alpha"]);
  });
});

describe("keyboard navigation and jump", () => {
  async function open() {
    setAtlasApi(fakeApi({ search: vi.fn(async () => ok(RESULTS)) }));
    mount();
    await userEvent.keyboard("{Control>}k{/Control}");
    await screen.findAllByRole("option");
  }
  const activeId = () => screen.getByRole("combobox").getAttribute("aria-activedescendant");

  it("ArrowDown/ArrowUp and Ctrl+N/Ctrl+P move aria-activedescendant, wrapping", async () => {
    await open();
    const opts = screen.getAllByRole("option");
    expect(activeId()).toBe(opts[0]!.id);
    expect(opts[0]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowDown}");
    expect(activeId()).toBe(opts[1]!.id);
    await userEvent.keyboard("{Control>}n{/Control}");
    expect(activeId()).toBe(opts[2]!.id);
    await userEvent.keyboard("{Control>}p{/Control}");
    expect(activeId()).toBe(opts[1]!.id);
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(activeId()).toBe(opts[3]!.id);
    expect(screen.getByRole("combobox")).toHaveFocus();
  });

  it("Enter on a project goes to /projects/:id and closes", async () => {
    await open();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(screen.getByTestId("where")).toHaveTextContent("/projects/p_a");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Enter on a phase goes to /sessions?project=&phase=", async () => {
    await open();
    await userEvent.keyboard("{ArrowUp}{Enter}");
    expect(screen.getByTestId("where")).toHaveTextContent("/sessions?project=p_b&phase=Hardening");
  });

  it("Enter on a session the board holds opens its drawer", async () => {
    useBoard.setState({ sessions: { "s-1": session("s-1") } });
    await open();
    await userEvent.keyboard("{Enter}");
    expect(useUi.getState().selectedSessionId).toBe("s-1");
    expect(useUi.getState().paletteOpen).toBe(false);
    expect(screen.getByTestId("where")).toHaveTextContent("/board");
  });

  it("Enter on a session the board does not hold goes to /sessions?open=", async () => {
    await open();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByTestId("where")).toHaveTextContent("/sessions?open=s-1");
    expect(useUi.getState().selectedSessionId).toBeNull();
  });

  it("Escape in the dialog does not reach a document-level Escape handler", async () => {
    await open();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    await userEvent.keyboard("{Escape}");
    document.removeEventListener("keydown", outer);
    expect(outer).not.toHaveBeenCalled();
  });
});

describe("request handling", () => {
  it("debounces typing into one request after the quiet period", async () => {
    vi.useFakeTimers();
    const search = vi.fn(async () => ok(RESULTS));
    setAtlasApi(fakeApi({ search }));
    mount();
    await act(async () => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(search).toHaveBeenCalledTimes(1); // the empty query, immediately
    const input = screen.getByRole("combobox");
    for (const v of ["a", "al", "alp"]) {
      fireEvent.change(input, { target: { value: v } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 20);
      });
    }
    expect(search).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });
    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenLastCalledWith("alp", expect.anything());
  });

  it("Enter before the new query's results arrive opens that query's first hit, not the stale one", async () => {
    vi.useFakeTimers();
    const fresh = [hit({ kind: "session", id: "quokka-1", title: "quokka work" })];
    const search = vi.fn(async (q: string) => ok(q === "quokka" ? fresh : RESULTS));
    setAtlasApi(fakeApi({ search }));
    mount();
    await act(async () => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "quokka" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("where").textContent).toBe("/board"); // nothing opened from the stale list
    expect(useUi.getState().selectedSessionId).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 10);
    });
    expect(screen.getByTestId("where").textContent).toBe("/sessions?open=quokka-1");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("aborts the previous request, and a slow first response never overwrites the second", async () => {
    const pending: Array<{
      q: string;
      signal: AbortSignal | undefined;
      resolve: (r: SearchResponse) => void;
    }> = [];
    const search = vi.fn(
      (q: string, o?: { signal?: AbortSignal }) =>
        new Promise<SearchResponse>((resolve) => pending.push({ q, signal: o?.signal, resolve })),
    );
    setAtlasApi(fakeApi({ search }));
    mount();
    await userEvent.keyboard("{Control>}k{/Control}");
    await waitFor(() => expect(pending).toHaveLength(1)); // ""
    await userEvent.keyboard("a");
    await waitFor(() => expect(pending).toHaveLength(2));
    await userEvent.keyboard("b");
    await waitFor(() => expect(pending).toHaveLength(3));
    expect(pending[0]!.signal?.aborted).toBe(true);
    expect(pending[1]!.signal?.aborted).toBe(true);
    expect(pending[2]!.signal?.aborted).toBe(false);
    // The newer answer arrives first, then the stale one (this fake ignores the abort signal).
    await act(async () =>
      pending[2]!.resolve(ok([hit({ kind: "project", id: "p_new", title: "new answer" })])),
    );
    await act(async () =>
      pending[1]!.resolve(ok([hit({ kind: "project", id: "p_old", title: "stale answer" })])),
    );
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option")).toHaveTextContent("new answer");
    expect(dialog()).toHaveAttribute("data-results-for", "ab");
  });
});

describe("archive hits (R5.3)", () => {
  it("marks an archived outcome hit, neutralizes its text, and Enter opens that session", async () => {
    const rlo = String.fromCodePoint(0x202e);
    setAtlasApi(
      fakeApi({
        search: vi.fn(async () =>
          ok([
            hit({
              kind: "session",
              id: "arch-1",
              title: `Spool${rlo} compaction`,
              snippet: `outcome: kestrel${rlo} shipped`,
              state: "archived",
            }),
          ]),
        ),
      }),
    );
    mount();
    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.keyboard("kestrel");
    const opt = await screen.findByRole("option");
    expect(opt).toHaveTextContent("Archived");
    expect(opt).toHaveTextContent("Spool<U+202E> compaction");
    expect(opt.textContent).not.toContain(rlo);
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent("/sessions?open=arch-1"),
    );
  });
});
