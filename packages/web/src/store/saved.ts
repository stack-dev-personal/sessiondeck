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
  InvalidResponseError,
  MissingRowError,
  NoHubError,
  withPut,
  type SavedAdapter,
  type SavedLayout,
} from "../layout/saved";
import { readStored, STORAGE_KEYS, writeStored } from "../lib/storage";
import type { BoardState } from "./board";
import { useLayout } from "./layout";
import { useUi, type Settings, type UiState } from "./ui";

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
  /** `hub` keys the browser cache; when it differs from the current one the rows are swapped out. */
  setAdapter: (a: SavedAdapter, hub?: string) => void;
  say: (tone: Notice["tone"], text: string) => void;
}

/** Cache key for a hub URL setting: the REST base, so ws:// and http:// forms of one hub agree. */
export const hubKey = (hubUrl: string): string => httpBase(hubUrl) ?? `invalid:${hubUrl.trim()}`;

/**
 * The cache is per hub: `{ hub, layouts }`. A cache with no `hub` field (written before the key
 * existed) belongs to hub "" (same origin); any other hub starts empty.
 */
function readCache(hub: string): unknown {
  const raw = readStored(STORAGE_KEYS.savedLayouts);
  if (raw === null) return { layouts: [] };
  try {
    const j = JSON.parse(raw) as unknown;
    const stored = isRecord(j) && typeof j["hub"] === "string" ? j["hub"] : "";
    return stored === hub ? j : { layouts: [] };
  } catch {
    return { layouts: [] };
  }
}
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const writeCache = (hub: string, rows: readonly SavedLayout[]) =>
  writeStored(STORAGE_KEYS.savedLayouts, JSON.stringify({ hub, layouts: rows.map(toWire) }));

/** The cache is as untrusted as the hub: it goes through the same row validation. */
export const loadCachedRows = (hub = ""): SavedLayout[] => parseRows(readCache(hub)).rows;

/** Adapter defaults to a throwing stub until startSaved() wires one. */
const NO_ADAPTER: SavedAdapter = {
  list: () => Promise.reject(new NoHubError("no adapter")),
  put: () => Promise.reject(new NoHubError("no adapter")),
  remove: () => Promise.reject(new NoHubError("no adapter")),
};

export const useSaved = create<SavedState>()((set, get) => {
  let adapter: SavedAdapter = NO_ADAPTER;
  let hub = hubKey(useUi.getState().settings.hubUrl);
  let n = 0;
  let loadSeq = 0;
  const say = (tone: Notice["tone"], text: string) => set({ notice: { n: ++n, tone, text } });
  const setRows = (rows: SavedLayout[]) => {
    writeCache(hub, rows);
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
  /**
   * A finished write settles the list: any GET still in flight started before it and may carry the
   * old rows, so it is invalidated. If one was still loading, the list is fetched again, so the
   * startup list never stays stale (the write's own rows are already applied meanwhile).
   * A write that outlives a change of hub is dropped.
   */
  const settled = (from: SavedAdapter, apply: () => void) => {
    if (from !== adapter) return;
    const cancelled = get().status === "loading";
    loadSeq++;
    apply();
    if (cancelled) void get().load();
  };
  const putRow = async (
    id: string,
    body: Pick<SavedLayout, "name" | "hotkey" | "host" | "spec">,
  ): Promise<SavedLayout> => {
    const from = adapter;
    const row = parseRow(await from.put(id, body));
    if (!row) throw new InvalidResponseError();
    settled(from, () => setRows(withPut(get().rows, row)));
    return row;
  };
  return {
    rows: loadCachedRows(hub),
    status: "idle",
    notice: null,
    say,
    setAdapter: (a, key) => {
      adapter = a;
      if (key !== undefined && key !== hub) {
        hub = key;
        loadSeq++; // an answer from the old hub must not land in the new hub's list
        set({ rows: loadCachedRows(hub), status: "idle" });
      }
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
        // While compact-all is on, the real layout is the snapshot; the all-compact spec is a view.
        const { spec, snapshot } = useLayout.getState();
        const cur = snapshot ?? spec;
        const row = await putRow(id, { name, hotkey, host, spec: { ...cur, id, name } });
        say("info", `Saved "${row.name}"${row.hotkey ? ` in slot ${row.hotkey}` : ""}.`);
      }),
    update: (id, patch) =>
      write("updating the layout", async () => {
        const cur = get().rows.find((r) => r.id === id);
        if (!cur) throw new MissingRowError();
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
        const from = adapter;
        await from.remove(id);
        settled(from, () => setRows(get().rows.filter((r) => r.id !== id)));
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
      return memoryAdapter(readCache(hubKey(s.hubUrl)));
    const base = httpBase(s.hubUrl);
    return base === null
      ? {
          list: () => Promise.reject(new NoHubError("invalid hub url")),
          put: () => Promise.reject(new NoHubError("invalid hub url")),
          remove: () => Promise.reject(new NoHubError("invalid hub url")),
        }
      : hubAdapter(base, s.token, fetchFn);
  };
  let cur = ui.getState().settings;
  saved.getState().setAdapter(pick(cur), hubKey(cur.hubUrl));
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
    saved.getState().setAdapter(pick(cur), hubKey(cur.hubUrl));
    void saved.getState().load();
  });
  return () => {
    unBoard();
    unUi();
  };
}
