import type { StoreApi, UseBoundStore } from "zustand";
import { create } from "zustand";
import {
  describeError,
  httpBase,
  hubAdapter,
  memoryAdapter,
  newLayoutId,
  parseRow,
  parseRows,
  resolveSlot,
  toWire,
  viewerHost,
  withPut,
  type SavedAdapter,
  type SavedLayout,
} from "../layout/saved";
import { readStored, STORAGE_KEYS, writeStored } from "../lib/storage";
import type { BoardState } from "./board";
import { useLayout } from "./layout";
import type { Settings, UiState } from "./ui";

export interface Notice {
  /** Increases on every notice, so the same text twice still re-announces. */
  n: number;
  tone: "info" | "error";
  text: string;
}

export interface SavedState {
  rows: SavedLayout[];
  /** loading: first fetch pending; ready: last fetch worked; offline: last fetch failed (cache shown). */
  status: "idle" | "loading" | "ready" | "offline";
  notice: Notice | null;
  load: () => Promise<void>;
  /** Saves the current layout under a new id. Returns an error text, or null on success. */
  save: (v: { name: string; hotkey: number | null; host: string | null }) => Promise<string | null>;
  update: (
    id: string,
    patch: Partial<{ name: string; hotkey: number | null; host: string | null }>,
  ) => Promise<string | null>;
  remove: (id: string) => Promise<string | null>;
  /** Hotkey: switches to the layout in `slot` for `host`, synchronously, from the cache. */
  press: (slot: number, host: string | null) => SavedLayout | null;
  /** Applies a saved layout by id (menu). */
  open: (id: string) => void;
  setAdapter: (a: SavedAdapter) => void;
  say: (tone: Notice["tone"], text: string) => void;
}

function readCache(): unknown {
  const raw = readStored(STORAGE_KEYS.savedLayouts);
  if (raw === null) return { layouts: [] };
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { layouts: [] };
  }
}
const writeCache = (rows: readonly SavedLayout[]) =>
  writeStored(STORAGE_KEYS.savedLayouts, JSON.stringify({ layouts: rows.map(toWire) }));

/** The cache is as untrusted as the hub: it goes through the same row validation. */
export const loadCachedRows = (): SavedLayout[] => parseRows(readCache()).rows;

/** Adapter defaults to a throwing stub until startSaved() wires one. */
const NO_ADAPTER: SavedAdapter = {
  list: () => Promise.reject(new Error("no adapter")),
  put: () => Promise.reject(new Error("no adapter")),
  remove: () => Promise.reject(new Error("no adapter")),
};

export const useSaved = create<SavedState>()((set, get) => {
  let adapter: SavedAdapter = NO_ADAPTER;
  let n = 0;
  let loadSeq = 0;
  const say = (tone: Notice["tone"], text: string) => set({ notice: { n: ++n, tone, text } });
  const setRows = (rows: SavedLayout[]) => {
    writeCache(rows);
    set({ rows });
  };
  /** Runs a write; shared error handling. */
  const write = async (what: string, run: () => Promise<void>): Promise<string | null> => {
    try {
      await run();
      return null;
    } catch (e) {
      const text = describeError(e, what);
      say("error", text);
      return text;
    }
  };
  const putRow = async (
    id: string,
    body: Pick<SavedLayout, "name" | "hotkey" | "host" | "spec">,
  ): Promise<SavedLayout> => {
    const row = parseRow(await adapter.put(id, body));
    if (!row) throw new Error("hub returned an invalid layout");
    setRows(withPut(get().rows, row));
    return row;
  };
  return {
    rows: loadCachedRows(),
    status: "idle",
    notice: null,
    say,
    setAdapter: (a) => {
      adapter = a;
    },
    load: async () => {
      const seq = ++loadSeq;
      set({ status: "loading" });
      try {
        const body = await adapter.list();
        if (seq !== loadSeq) return; // a newer load (reconnect, settings change) owns the result
        const { rows, dropped } = parseRows(body);
        setRows(rows);
        set({ status: "ready" });
        if (dropped > 0)
          say(
            "error",
            `Ignored ${dropped} saved ${dropped === 1 ? "layout" : "layouts"} the hub sent that did not validate.`,
          );
      } catch (e) {
        if (seq !== loadSeq) return;
        set({ status: "offline" });
        say("error", describeError(e, "loading saved layouts"));
      }
    },
    save: ({ name, hotkey, host }) =>
      write("saving the layout", async () => {
        const id = newLayoutId();
        const cur = useLayout.getState().spec;
        const row = await putRow(id, { name, hotkey, host, spec: { ...cur, id, name } });
        say("info", `Saved "${row.name}"${row.hotkey ? ` in slot ${row.hotkey}` : ""}.`);
      }),
    update: (id, patch) =>
      write("updating the layout", async () => {
        const cur = get().rows.find((r) => r.id === id);
        if (!cur) throw new Error("missing");
        const name = patch.name ?? cur.name;
        const row = await putRow(id, {
          name,
          hotkey: patch.hotkey !== undefined ? patch.hotkey : cur.hotkey,
          host: patch.host !== undefined ? patch.host : cur.host,
          spec: { ...cur.spec, name },
        });
        say("info", `Updated "${row.name}".`);
      }),
    remove: (id) =>
      write("deleting the layout", async () => {
        const cur = get().rows.find((r) => r.id === id);
        await adapter.remove(id);
        setRows(get().rows.filter((r) => r.id !== id));
        say("info", `Deleted "${cur?.name ?? id}".`);
      }),
    press: (slot, host) => {
      const row = resolveSlot(get().rows, host, slot);
      if (!row) {
        say("info", `No layout in slot ${slot}.`);
        return null;
      }
      useLayout.getState().setSpec(row.spec);
      say("info", `Layout ${slot}: ${row.name}`);
      return row;
    },
    open: (id) => {
      const row = get().rows.find((r) => r.id === id);
      if (!row) return;
      useLayout.getState().setSpec(row.spec);
      say("info", `Layout: ${row.name}`);
    },
  };
});

/** The host used for the pin rule, as a hook-friendly selector. */
export const selectViewerHost = (s: BoardState): string | null => viewerHost(s.sessions);

/**
 * Wires saved layouts to the hub: load now, again whenever the stream (re)opens, and on a changed
 * hub URL or token. Mock builds with no hub URL use the in-memory adapter, seeded from the cache.
 */
export function startSaved(
  board: UseBoundStore<StoreApi<BoardState>>,
  ui: UseBoundStore<StoreApi<Pick<UiState, "settings">>>,
  saved: UseBoundStore<StoreApi<SavedState>> = useSaved,
  fetchFn?: typeof fetch,
): () => void {
  const pick = (s: Settings): SavedAdapter => {
    if (import.meta.env.VITE_MOCK === "1" && s.hubUrl.trim() === "")
      return memoryAdapter(readCache());
    const base = httpBase(s.hubUrl);
    return base === null
      ? {
          list: () => Promise.reject(new Error("invalid hub url")),
          put: () => Promise.reject(new Error("invalid hub url")),
          remove: () => Promise.reject(new Error("invalid hub url")),
        }
      : hubAdapter(base, s.token, fetchFn);
  };
  let cur = ui.getState().settings;
  saved.getState().setAdapter(pick(cur));
  void saved.getState().load();
  let conn = board.getState().connection;
  const unBoard = board.subscribe((b) => {
    if (b.connection === conn) return;
    const was = conn;
    conn = b.connection;
    if (conn === "open" && was !== "open") void saved.getState().load();
  });
  const unUi = ui.subscribe((u) => {
    const next = u.settings;
    if (next.hubUrl === cur.hubUrl && next.token === cur.token) return;
    cur = next;
    saved.getState().setAdapter(pick(cur));
    void saved.getState().load();
  });
  return () => {
    unBoard();
    unUi();
  };
}
