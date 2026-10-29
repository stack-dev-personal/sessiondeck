import type { Store } from "./store.ts";

// Phase 7 (Postgres): (1) concurrent PUTs to the same slot under READ COMMITTED can both pass the
// clearing UPDATE and then one hits the unique index; retry on 23505 or take an advisory lock.
// (2) pg returns BIGINT (updated_at) as a string; parse it when mapping rows.

export const MAX_LAYOUTS = 200;

export interface LayoutRow {
  id: string;
  name: string;
  hotkey: number | null;
  host: string | null;
  spec: string;
  updated_at: number;
}

export type PutResult =
  { ok: true; row: LayoutRow } | { ok: false; reason: "builtin" | "full" | "slot_reserved" };

/** Saved (non-builtin) layouts, optionally the ones pinned to `host` plus the unpinned ones. */
export function listLayouts(store: Store, host?: string): LayoutRow[] {
  return host === undefined
    ? (store.db
        .prepare(
          `SELECT id, name, hotkey, host, spec, updated_at FROM layouts WHERE builtin = 0 ORDER BY updated_at DESC, id`,
        )
        .all() as LayoutRow[])
    : (store.db
        .prepare(
          "SELECT id, name, hotkey, host, spec, updated_at FROM layouts WHERE builtin = 0 AND (host IS NULL OR host = ?) ORDER BY updated_at DESC, id",
        )
        .all(host) as LayoutRow[]);
}

/** Upsert in one transaction; a hotkey held by another layout in the same host scope is moved. */
export function putLayout(
  store: Store,
  v: { id: string; name: string; hotkey: number | null; host: string | null; spec: string },
  nowMs: number,
): PutResult {
  const tx = store.db.transaction((): PutResult => {
    const cur = store.db.prepare("SELECT builtin FROM layouts WHERE id = ?").get(v.id) as
      { builtin: number | null } | undefined;
    if (cur?.builtin) return { ok: false, reason: "builtin" };
    if (cur === undefined) {
      const n = store.db.prepare("SELECT COUNT(*) AS n FROM layouts WHERE builtin = 0").get() as {
        n: number;
      };
      if (n.n >= MAX_LAYOUTS) return { ok: false, reason: "full" };
    }
    if (v.hotkey !== null) {
      // Builtin rows never hold hotkeys; if one does (seeded data), the slot is reserved, not moved.
      const reserved = store.db
        .prepare(
          "SELECT 1 FROM layouts WHERE builtin = 1 AND hotkey = ? AND COALESCE(host, '') = ?",
        )
        .get(v.hotkey, v.host ?? "");
      if (reserved !== undefined) return { ok: false, reason: "slot_reserved" };
      store.db
        .prepare(
          "UPDATE layouts SET hotkey = NULL, updated_at = ? WHERE hotkey = ? AND COALESCE(host, '') = ? AND id <> ? AND builtin = 0",
        )
        .run(nowMs, v.hotkey, v.host ?? "", v.id);
    }
    store.db
      .prepare(
        `INSERT INTO layouts (id, name, spec, builtin, hotkey, host, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, spec = excluded.spec, hotkey = excluded.hotkey, host = excluded.host, updated_at = excluded.updated_at`,
      )
      .run(v.id, v.name, v.spec, v.hotkey, v.host, nowMs);
    return {
      ok: true,
      row: {
        id: v.id,
        name: v.name,
        hotkey: v.hotkey,
        host: v.host,
        spec: v.spec,
        updated_at: nowMs,
      },
    };
  });
  return tx();
}

export function deleteLayout(store: Store, id: string): "deleted" | "missing" | "builtin" {
  const cur = store.db.prepare("SELECT builtin FROM layouts WHERE id = ?").get(id) as
    { builtin: number | null } | undefined;
  if (cur === undefined) return "missing";
  if (cur.builtin) return "builtin";
  store.db.prepare("DELETE FROM layouts WHERE id = ? AND builtin = 0").run(id);
  return "deleted";
}
