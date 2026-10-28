import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  dir = mkdtempSync(path.join(os.tmpdir(), "hub-fix1-"));
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
const ids = (s: Store, q: string) => s.search(q, 20).map((h) => `${h.kind}:${h.id}`);
const docs = (s: Store, ref: string) =>
  (
    s.db
      .prepare("SELECT COUNT(*) AS n FROM search_docs WHERE kind = 'session' AND ref_id = ?")
      .get(ref) as { n: number }
  ).n;
// Reaches the private writer of search documents to inject a failure.
const failOn = (s: Store, ref: string, on: { value: boolean }) => {
  const real = (s as never as Record<string, (...a: unknown[]) => unknown>)["putDoc"]!.bind(s);
  (s as never as Record<string, unknown>)["putDoc"] = (...a: unknown[]) => {
    if (on.value && a[1] === ref) throw new Error("injected");
    return real(...a);
  };
};

describe("R5.4 deferred indexing, fix round 1", () => {
  it("a crash between commit and flush loses nothing: the next open indexes the dirty row", () => {
    const s = open();
    seedSession(s, "s1", { last_prompt: "first banana" });
    s.flushSearchIndex();
    expect(ids(s, "banana")).toEqual(["session:s1"]);
    seedSession(s, "s1", { last_prompt: "second cherry" });
    s.db.close(); // SIGKILL stand-in: no flush
    opened.pop();
    const s2 = open();
    expect(ids(s2, "cherry")).toEqual(["session:s1"]);
    expect(ids(s2, "banana")).toEqual([]);
  });

  it("an ended session's final text is searchable after a crash", () => {
    const s = open();
    seedSession(s, "s1", { last_prompt: "first banana" });
    s.flushSearchIndex();
    seedSession(s, "s1", { last_prompt: "final mango", state: "ended" } as never);
    s.db.close();
    opened.pop();
    expect(ids(open(), "mango")).toEqual(["session:s1"]);
  });

  it("a failing session is re-queued, does not block others or searches, and recovers", () => {
    const s = open();
    const errs: unknown[] = [];
    s.onSearchFlushError = (e) => errs.push(e);
    const on = { value: true };
    failOn(s, "bad", on);
    seedSession(s, "good", { last_prompt: "kiwi" });
    seedSession(s, "bad", { last_prompt: "kiwi" });
    expect(ids(s, "kiwi")).toEqual(["session:good"]); // search serves the committed index
    expect(errs.length).toBe(1);
    on.value = false;
    s.flushSearchIndex();
    expect(ids(s, "kiwi").sort()).toEqual(["session:bad", "session:good"]);
  });

  it("quarantines a poisoned session after repeated failures, naming only its id", () => {
    const s = open();
    const errs: Error[] = [];
    s.onSearchFlushError = (e) => errs.push(e as Error);
    failOn(s, "bad", { value: true });
    seedSession(s, "bad", { last_prompt: "kiwi" });
    for (let i = 0; i < 5; i++) s.flushSearchIndex();
    expect(errs.filter((e) => e.message.includes("quarantined session bad")).length).toBe(1);
    expect(errs.length).toBe(3); // two plain failures, then the quarantine; later flushes skip it
  });

  it("close() flushes pending ids, and nothing flushes after close", async () => {
    const s = open();
    const errs: unknown[] = [];
    s.onSearchFlushError = (e) => errs.push(e);
    seedSession(s, "s1", { last_prompt: "walrus" });
    s.close();
    opened.pop();
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(file, { readonly: true });
    expect(
      (
        raw.prepare("SELECT COUNT(*) AS n FROM search_docs WHERE ref_id = 's1'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    raw.close();
    const s2 = open();
    seedSession(s2, "s2", { last_prompt: "ferret" });
    s2.close();
    opened.pop();
    await new Promise((r) => setTimeout(r, 400)); // the cancelled timer must not touch a closed handle
    expect(errs).toEqual([]);
    expect(() => s2.flushSearchIndex()).not.toThrow();
  });

  it("after a restart (empty cache) the first ingest that renames a phase drops the old phase document", () => {
    const s = open();
    seedSession(s, "s1", { session_name: "P5 atlas", project_dir: "/r/app" });
    s.flushSearchIndex();
    expect(ids(s, "p5").sort()).toEqual(["phase:P5", "session:s1"]);
    s.close();
    opened.pop();
    const s2 = open();
    seedSession(s2, "s1", { session_name: "P6 atlas", project_dir: "/r/app" });
    s2.flushSearchIndex();
    expect(ids(s2, "p5")).toEqual([]);
    expect(ids(s2, "p6").some((x) => x.startsWith("phase:"))).toBe(true);
  });

  it("a failed flush does not poison the cache: the retry still reindexes the phases", () => {
    const s = open();
    seedSession(s, "s1", { session_name: "P5 atlas", project_dir: "/r/app" });
    s.flushSearchIndex();
    s.close();
    opened.pop();
    const s2 = open();
    const on = { value: true };
    failOn(s2, "s1", on);
    seedSession(s2, "s1", { session_name: "P6 atlas", project_dir: "/r/app" });
    s2.onSearchFlushError = () => {};
    s2.flushSearchIndex();
    on.value = false;
    s2.flushSearchIndex();
    expect(ids(s2, "p5")).toEqual([]);
    expect(docs(s2, "s1")).toBe(1);
  });

  it("the cache that tracks indexed phases is bounded", () => {
    const s = open();
    for (let i = 0; i < 4200; i++) seedSession(s, `s${i}`, { last_prompt: "x" });
    s.flushSearchIndex();
    expect((s as never as { indexedAs: Map<string, unknown> }).indexedAs.size).toBeLessThanOrEqual(
      4096,
    );
    vi.restoreAllMocks();
  });
});
