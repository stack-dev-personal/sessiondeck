/**
 * Saved layouts (R6.3), the pure half: row validation, the hotkey pin rule, the hub HTTP adapter
 * and an in-memory adapter with the same interface (mock mode). No React, no store.
 *
 * Everything the hub sends is untrusted: every row goes through parseRow(), which runs the layout
 * spec validator (depth, pane and child caps, id rules) and drops what fails. Rows are kept in
 * arrays and compared by id; no object is ever indexed by a hub-supplied id.
 */
import { validate, type LayoutSpec } from "./spec";

export interface SavedLayout {
  id: string;
  name: string;
  /** Slot 1-9, or null. */
  hotkey: number | null;
  /** Host this layout is pinned to, or null for every host. */
  host: string | null;
  spec: LayoutSpec;
  updatedAt: number;
}

/** What the hub accepts on PUT /layouts/:id. */
export interface SavedBody {
  name: string;
  hotkey: number | null;
  host: string | null;
  spec: LayoutSpec;
}

export const MAX_SAVED = 200;
export const MAX_NAME = 80;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** One hub row, or null when anything about it is off. Never throws. */
export function parseRow(v: unknown): SavedLayout | null {
  if (!isObj(v)) return null;
  const { id, name, hotkey, host, spec, updated_at } = v;
  if (typeof id !== "string" || !ID_RE.test(id)) return null;
  if (typeof name !== "string" || name.length < 1 || name.length > MAX_NAME) return null;
  if (
    hotkey !== null &&
    !(Number.isInteger(hotkey) && (hotkey as number) >= 1 && (hotkey as number) <= 9)
  )
    return null;
  if (host !== null && !(typeof host === "string" && host.length >= 1 && host.length <= 128))
    return null;
  const r = validate(spec);
  if (!r.ok) return null;
  return {
    id,
    name,
    hotkey: hotkey as number | null,
    host: host as string | null,
    spec: r.spec,
    updatedAt: typeof updated_at === "number" && Number.isFinite(updated_at) ? updated_at : 0,
  };
}

/** Rows from a GET /layouts body (or the cache). Invalid rows and duplicate ids are dropped. */
export function parseRows(body: unknown): { rows: SavedLayout[]; dropped: number } {
  const list = isObj(body) && Array.isArray(body["layouts"]) ? (body["layouts"] as unknown[]) : [];
  const rows: SavedLayout[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of list.slice(0, MAX_SAVED)) {
    const row = parseRow(raw);
    if (!row || seen.has(row.id)) dropped++;
    else {
      seen.add(row.id);
      rows.push(row);
    }
  }
  dropped += Math.max(0, list.length - MAX_SAVED);
  return { rows, dropped };
}

/** The wire shape of a row (also the cache shape). */
export function toWire(r: SavedLayout) {
  return {
    id: r.id,
    name: r.name,
    hotkey: r.hotkey,
    host: r.host,
    spec: r.spec,
    updated_at: r.updatedAt,
  };
}

/**
 * Which row a key opens on `host`: a layout pinned to that host beats an unpinned one holding the
 * same slot. `host` is the explicit Viewer host setting (null: only unpinned layouts resolve).
 * Computed here (not read from the hub's active_hotkey) so it needs no refetch; the hub rule is the
 * same (see packages/hub/src/routes/layouts.ts).
 */
export function resolveSlot(
  rows: readonly SavedLayout[],
  host: string | null,
  slot: number,
): SavedLayout | null {
  const held = rows.filter((r) => r.hotkey === slot);
  const pinned = host === null ? undefined : held.find((r) => r.host === host);
  return pinned ?? held.find((r) => r.host === null) ?? null;
}

/** Applies the hub's rule locally after a PUT: a slot moves within its host scope. */
export function withPut(rows: readonly SavedLayout[], row: SavedLayout): SavedLayout[] {
  const rest = rows
    .filter((r) => r.id !== row.id)
    .map((r) =>
      row.hotkey !== null && r.hotkey === row.hotkey && r.host === row.host
        ? { ...r, hotkey: null }
        : r,
    );
  return [row, ...rest];
}

let counter = 0;
/** A hub-legal id for a new layout. */
export function newLayoutId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `u-${rand}${(counter++).toString(36)}`;
}

// ---- adapters ---------------------------------------------------------------------------------

export class HubError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null = null,
    readonly reason: string | null = null,
  ) {
    super(`hub ${status}${code ? ` ${code}` : ""}`);
  }
}

/** The hub's answer was not a layout this app accepts. */
export class InvalidResponseError extends Error {
  constructor() {
    super("invalid layout response");
  }
}

/** The layout to update is not in the local list (deleted elsewhere, or the list changed hubs). */
export class MissingRowError extends Error {
  constructor() {
    super("layout not in the local list");
  }
}

/** No usable hub address: nothing was sent. Reported like a network failure. */
export class NoHubError extends Error {
  constructor(why: string) {
    super(why);
  }
}

/** The same interface for the hub and for mock mode. `list` and `put` return untrusted bodies. */
export interface SavedAdapter {
  list: () => Promise<unknown>;
  put: (id: string, body: SavedBody) => Promise<unknown>;
  remove: (id: string) => Promise<void>;
}

/** http(s) base of the hub for REST calls: "" is same origin, ws(s) maps to http(s), else null. */
export function httpBase(hubUrl: string): string | null {
  const raw = hubUrl.trim();
  if (raw === "") return "";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol === "ws:") u.protocol = "http:";
  else if (u.protocol === "wss:") u.protocol = "https:";
  else if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

export function hubAdapter(
  base: string,
  token: string,
  fetchFn: typeof fetch = (...a) => fetch(...a),
  timeoutMs = 10_000,
): SavedAdapter {
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetchFn(`${base}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      let code: string | null = null;
      let reason: string | null = null;
      try {
        const j = (await res.json()) as unknown;
        if (isObj(j)) {
          if (typeof j["error"] === "string") code = j["error"];
          if (typeof j["reason"] === "string") reason = j["reason"];
        }
      } catch {
        /* empty or non-JSON error body (429 and 401 have none) */
      }
      throw new HubError(res.status, code, reason);
    }
    return res;
  };
  return {
    list: async () => (await call("/layouts")).json() as Promise<unknown>,
    put: async (id, body) =>
      (
        await call(`/layouts/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: JSON.stringify(body),
        })
      ).json() as Promise<unknown>,
    remove: async (id) => {
      await call(`/layouts/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
  };
}

/** Mock mode: same interface, same hotkey-move rule, nothing leaves the page. */
export function memoryAdapter(initial: unknown = { layouts: [] }): SavedAdapter {
  let rows = parseRows(initial).rows;
  let clock = 1;
  return {
    list: () => Promise.resolve({ layouts: rows.map(toWire) }),
    put: (id, body) => {
      const r = parseRow({ id, ...body, updated_at: clock++ });
      if (!r) return Promise.reject(new HubError(400, "invalid_body", "spec"));
      if (!rows.some((x) => x.id === id) && rows.length >= MAX_SAVED)
        return Promise.reject(new HubError(409, "layout_limit"));
      rows = withPut(rows, r);
      return Promise.resolve(toWire(r));
    },
    remove: (id) => {
      if (!rows.some((x) => x.id === id)) return Promise.reject(new HubError(404));
      rows = rows.filter((x) => x.id !== id);
      return Promise.resolve();
    },
  };
}

/** What to tell the user. Never includes the token or the response body. */
export function describeError(e: unknown, what: string): string {
  if (e instanceof HubError) {
    if (e.status === 401) return `Hub rejected the token while ${what}. Check Settings.`;
    if (e.status === 429) return `Too many layout changes while ${what}. Wait a moment and retry.`;
    if (e.status === 409 && e.code === "slot_reserved")
      return `That slot is reserved by a builtin layout. Pick another slot.`;
    if (e.status === 409)
      return `The hub is at its limit of ${MAX_SAVED} saved layouts. Delete one first.`;
    if (e.status === 403) return `That layout is builtin and cannot be changed.`;
    if (e.status === 404) return `That layout no longer exists on the hub.`;
    if (e.status === 400) return `The hub refused the layout${e.reason ? ` (${e.reason})` : ""}.`;
    return `The hub answered ${e.status} while ${what}.`;
  }
  if (e instanceof InvalidResponseError)
    return `The hub sent a layout this app cannot read while ${what}.`;
  if (e instanceof MissingRowError)
    return `That layout is no longer in the list while ${what}. Close and reopen Saved layouts.`;
  const network =
    e instanceof TypeError ||
    e instanceof NoHubError ||
    (typeof DOMException !== "undefined" &&
      e instanceof DOMException &&
      (e.name === "TimeoutError" || e.name === "AbortError"));
  if (network)
    return `Cannot reach the hub while ${what}. Showing saved layouts from this browser.`;
  return `Unexpected error while ${what}.`;
}
