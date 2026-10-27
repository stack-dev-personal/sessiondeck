import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/db/store.ts";
import { migrations } from "../src/db/migrations.ts";
import { afterEach, describe, expect, it } from "vitest";
import { tempStore } from "./helpers.ts";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe("migrations", () => {
  it("creates all tables and indexes, is idempotent, records versions 1 to 4", () => {
    const t = tempStore({ file: true });
    cleanup = t.cleanup;
    expect(t.store.migrate()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
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
        "session_baselines",
        "compaction_state",
        "hub_lease",
        "schema_migrations",
      ]),
    );
    expect(names("index")).toEqual(
      expect.arrayContaining(["events_session_ts_sig", "sessions_host_state"]),
    );
    // events_signature -> events_signature_ts (migration 2) -> events_session_ts_sig (migration 5)
    for (const old of ["events_signature", "events_signature_ts", "events_session_ts"]) {
      expect(names("index")).not.toContain(old);
    }
    expect(t.store.migrate()).toEqual([]);
    expect(t.store.schemaVersion()).toBe(9);
  });

  it("sets WAL and foreign keys", () => {
    const t = tempStore({ file: true });
    cleanup = t.cleanup;
    expect(t.store.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(t.store.db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("enforces UNIQUE(host, seq)", () => {
    const t = tempStore({ file: true });
    cleanup = t.cleanup;
    t.store.migrate();
    const ins = t.store.db.prepare(
      "INSERT INTO events (id, host, seq, kind, ts, payload) VALUES (?, 'h', 1, 'hook', 0, '{}')",
    );
    ins.run("a");
    expect(() => ins.run("b")).toThrow(/UNIQUE/);
  });

  it("round-trips hosts and sessions", () => {
    const t = tempStore({ file: true });
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
    expect(t.store.getSession("s")).toMatchObject(s);
    expect(t.store.getSession("nope")).toBeUndefined();
  });

  it("main-session transcript lines dedup on ('' agent_id); NULL agent_id is rejected", () => {
    const t = tempStore({ file: true });
    cleanup = t.cleanup;
    t.store.migrate();
    const ins = t.store.db.prepare(
      "INSERT INTO transcript_lines (session_id, agent_id, line_no, ts, raw) VALUES (?, ?, 1, 0, 'x')",
    );
    ins.run("s", "");
    expect(() => ins.run("s", "")).toThrow(/UNIQUE/);
    expect(() => ins.run("s", null)).toThrow(/NOT NULL/);
    const s = t.store.db.prepare("INSERT INTO statusline_samples (session_id, ts) VALUES (?, ?)");
    expect(() => s.run("s", null)).toThrow(/NOT NULL/);
    expect(() => s.run(null, 1)).toThrow(/NOT NULL/);
  });

  it("DDL uses BIGINT for ms columns and no 32-bit INTEGER time columns", () => {
    const ddl = migrations.map((m) => m.sql).join("\n");
    for (const col of [
      "last_seen",
      "started_at",
      "last_event_at",
      "ended_at",
      "five_hour_resets",
      "seven_day_resets",
    ]) {
      expect(ddl, col).toMatch(new RegExp(`${col} BIGINT`));
    }
    expect(ddl).toMatch(/ts BIGINT NOT NULL/);
    expect(ddl).not.toMatch(/\b(ts|last_seen|started_at|ended_at|last_event_at) INTEGER/);
    const t = tempStore({ file: true });
    cleanup = t.cleanup;
    t.store.migrate();
    t.store.upsertHost({ host: "h", os: null, last_seen: 1_760_000_000_000, last_seq: 1 });
    expect(t.store.getHost("h")?.last_seen).toBe(1_760_000_000_000);
  });

  it.skipIf(process.platform === "win32")("db dir is 0700, db and sidecars are 0600", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hub-mode-"));
    const sub = path.join(dir, "nested", "data");
    const store = Store.open(path.join(sub, "hub.sqlite"));
    try {
      store.migrate();
      store.upsertHost({ host: "h", os: null, last_seen: 1, last_seq: 1 });
      const mode = (p: string) => statSync(p).mode & 0o777;
      expect(mode(sub)).toBe(0o700);
      for (const f of ["hub.sqlite", "hub.sqlite-wal", "hub.sqlite-shm"]) {
        expect(mode(path.join(sub, f)), f).toBe(0o600);
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
