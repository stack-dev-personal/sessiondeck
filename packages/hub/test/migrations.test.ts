import { afterEach, describe, expect, it } from "vitest";
import { tempStore } from "./helpers.ts";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe("migrations", () => {
  it("creates all tables and indexes, is idempotent, records version 1", () => {
    const t = tempStore();
    cleanup = t.cleanup;
    expect(t.store.migrate()).toEqual([1]);
    const names = (type: string) =>
      (
        t.store.db
          .prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name")
          .all(type) as { name: string }[]
      ).map((r) => r.name);
    expect(names("table")).toEqual(
      expect.arrayContaining([
        "hosts",
        "events",
        "sessions",
        "transcript_lines",
        "statusline_samples",
        "projects",
        "layouts",
        "schema_migrations",
      ]),
    );
    expect(names("index")).toEqual(
      expect.arrayContaining(["events_session_ts", "events_signature"]),
    );
    expect(t.store.migrate()).toEqual([]);
    expect(t.store.schemaVersion()).toBe(1);
  });

  it("sets WAL and foreign keys", () => {
    const t = tempStore();
    cleanup = t.cleanup;
    expect(t.store.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(t.store.db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("enforces UNIQUE(host, seq)", () => {
    const t = tempStore();
    cleanup = t.cleanup;
    t.store.migrate();
    const ins = t.store.db.prepare(
      "INSERT INTO events (id, host, seq, kind, ts, payload) VALUES (?, 'h', 1, 'hook', 0, '{}')",
    );
    ins.run("a");
    expect(() => ins.run("b")).toThrow(/UNIQUE/);
  });

  it("round-trips hosts and sessions", () => {
    const t = tempStore();
    cleanup = t.cleanup;
    t.store.migrate();
    t.store.upsertHost({ host: "h", os: "linux", last_seen: 1, last_seq: 2 });
    t.store.upsertHost({ host: "h", os: "linux", last_seen: 5, last_seq: 6 });
    expect(t.store.getHost("h")?.last_seq).toBe(6);
    const s = {
      session_id: "s",
      host: "h",
      snapshot: "{}",
      state: "idle",
      project_dir: null,
      started_at: 1,
      last_event_at: 2,
      ended_at: null,
    };
    t.store.upsertSession(s);
    expect(t.store.getSession("s")).toEqual(s);
    expect(t.store.getSession("nope")).toBeUndefined();
  });
});
