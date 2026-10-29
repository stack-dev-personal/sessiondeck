import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/db/store.ts";
import { seedSession } from "./support/hub.ts";

let dir: string;
let file: string;
const opened: Store[] = [];
function open(): Store {
  const s = Store.open(file);
  s.migrate();
  opened.push(s);
  return s;
}
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "hub-fix2-"));
  file = path.join(dir, "hub.sqlite");
});
afterEach(() => {
  for (const s of opened.splice(0)) {
    try {
      s.close();
    } catch {
      // already closed
    }
  }
  rmSync(dir, { recursive: true, force: true });
});
type Priv = Record<string, unknown>;
const ids = (s: Store, q: string) => s.search(q, 20).map((h) => `${h.kind}:${h.id}`);
const dirtyCount = (s: Store) =>
  (s.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE search_dirty = 1").get() as { n: number })
    .n;
const failPutDoc = (s: Store, match: (ref: string) => boolean) => {
  const real = (s as never as Record<string, (...a: unknown[]) => unknown>)["putDoc"]!.bind(s);
  (s as never as Priv)["putDoc"] = (...a: unknown[]) => {
    if (a[0] === "session" && match(a[1] as string)) throw new Error("injected");
    return real(...a);
  };
};

describe("R5.4 deferred indexing, fix round 2", () => {
  it("migration 8 flags existing sessions so entries stale from the old design are repaired", async () => {
    const s = open();
    seedSession(s, "s1", { last_prompt: "banana" });
    s.flushSearchIndex();
    // Stand-in for a database written by the older design: migration 8 not yet applied, stale index.
    s.db.prepare("DELETE FROM schema_migrations WHERE version IN (8, 9)").run();
    s.db.prepare("DROP INDEX layouts_slot").run();
    for (const c of ["hotkey", "host", "updated_at"])
      s.db.prepare(`ALTER TABLE layouts DROP COLUMN ${c}`).run();
    s.db.prepare("DROP INDEX sessions_search_dirty").run();
    s.db.prepare("ALTER TABLE sessions DROP COLUMN search_dirty").run();
    s.db.prepare("UPDATE sessions SET snapshot = replace(snapshot, 'banana', 'cherry')").run();
    s.db.close();
    opened.pop();
    const s2 = open();
    expect(ids(s2, "cherry")).toEqual(["session:s1"]);
    expect(ids(s2, "banana")).toEqual([]);
  });

  it("a failed phase rebuild keeps the session dirty, and the next flush repairs the phase document", () => {
    const s = open();
    seedSession(s, "s1", { session_name: "P5 atlas", project_dir: "/r/app" });
    s.flushSearchIndex();
    expect(ids(s, "p5").sort()).toEqual(["phase:P5", "session:s1"]);
    const errs: unknown[] = [];
    s.onSearchFlushError = (e) => errs.push(e);
    const real = (s as never as Record<string, (...a: unknown[]) => unknown>)[
      "reindexProjectPhases"
    ]!.bind(s);
    let fail = true;
    (s as never as Priv)["reindexProjectPhases"] = (...a: unknown[]) => {
      if (fail) throw new Error("rebuild injected");
      return real(...a);
    };
    seedSession(s, "s1", { session_name: "P6 atlas", project_dir: "/r/app" });
    s.flushSearchIndex();
    expect(errs.length).toBe(1);
    expect(dirtyCount(s)).toBe(1); // kept for the next flush
    fail = false;
    s.flushSearchIndex();
    expect(dirtyCount(s)).toBe(0);
    expect(ids(s, "p5")).toEqual([]);
    expect(ids(s, "p6").some((x) => x.startsWith("phase:"))).toBe(true);
  });

  it("when only quarantined rows are dirty, a search does not page them", () => {
    const s = open();
    s.onSearchFlushError = () => {};
    failPutDoc(s, (r) => r === "bad");
    seedSession(s, "bad", { last_prompt: "kiwi" });
    for (let i = 0; i < 3; i++) s.flushSearchIndex();
    expect((s as never as { quarantined: Map<string, number> }).quarantined.size).toBe(1);
    let pages = 0;
    const realStmt = (s as never as Record<string, (...a: unknown[]) => unknown>)["stmt"]!.bind(s);
    (s as never as Priv)["stmt"] = (sql: string) => {
      if (sql.includes("SELECT session_id, snapshot")) pages++;
      return realStmt(sql);
    };
    for (let i = 0; i < 3; i++) s.search("kiwi", 5);
    expect(pages).toBe(0);
    expect(dirtyCount(s)).toBe(1);
  });

  it("failure and quarantine state is capped at 4096 and dropped for ids no longer dirty", () => {
    const s = open();
    s.onSearchFlushError = () => {};
    failPutDoc(s, () => true);
    s.db.transaction(() => {
      for (let i = 0; i < 4200; i++) seedSession(s, `s${i}`, { last_prompt: "x" });
    })();
    const p = s as never as {
      flushFailures: Map<string, number>;
      quarantined: Map<string, number>;
    };
    s.flushSearchIndex();
    expect(p.flushFailures.size).toBeLessThanOrEqual(4096);
    s.flushSearchIndex();
    s.flushSearchIndex();
    expect(p.quarantined.size).toBeLessThanOrEqual(4096);
  });

  it("failure and quarantine state for ids that left the dirty set is dropped", () => {
    const s = open();
    s.onSearchFlushError = () => {};
    failPutDoc(s, (r) => r.startsWith("bad"));
    seedSession(s, "bad1", { last_prompt: "x" });
    seedSession(s, "bad2", { last_prompt: "x" });
    for (let i = 0; i < 3; i++) s.flushSearchIndex();
    const p = s as never as {
      flushFailures: Map<string, number>;
      quarantined: Map<string, number>;
    };
    expect(p.quarantined.size).toBe(2);
    seedSession(s, "bad3", { last_prompt: "x" });
    s.flushSearchIndex();
    expect(p.flushFailures.size).toBe(1); // bad3
    s.db.prepare("UPDATE sessions SET search_dirty = 0 WHERE session_id = 'bad1'").run();
    seedSession(s, "good", { last_prompt: "y" });
    s.flushSearchIndex();
    expect([...p.quarantined.keys()]).toEqual(["bad2"]);
  });

  it("opening commits per page: finished pages survive an interrupted open", () => {
    const s = open();
    s.db.transaction(() => {
      for (let i = 0; i < 1200; i++)
        seedSession(s, `s${String(i).padStart(4, "0")}`, { last_prompt: "x" });
    })();
    s.flushSearchIndex();
    s.db.prepare("UPDATE sessions SET search_dirty = 1").run(); // as if every row were re-flagged
    s.db.close(); // crash
    opened.pop();
    const s2 = Store.open(file);
    opened.push(s2);
    let n = 0;
    const real = (s2 as never as Record<string, (...a: unknown[]) => unknown>)[
      "indexSession"
    ]!.bind(s2);
    (s2 as never as Priv)["indexSession"] = (...a: unknown[]) => {
      // A non-Error abort inside the page transaction but outside the per-session savepoint is not
      // possible here, so interrupt by killing the handle after the first page has been indexed.
      if (++n === 501) s2.db.close();
      return real(...a);
    };
    s2.onSearchFlushError = () => {};
    s2.migrate();
    const raw = Store.open(file);
    opened.push(raw);
    // page 1 (500 rows) was committed before the handle died; the rest is still flagged
    expect(dirtyCount(raw)).toBeLessThan(1200);
    expect(dirtyCount(raw)).toBeGreaterThan(0);
  });
});
