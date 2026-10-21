import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { Store } from "../src/db/store.ts";

const posix = process.platform !== "win32";
const mode = (p: string) => statSync(p).mode & 0o777;
let tmp = "";
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!posix)("db directory modes", () => {
  it("existing directory keeps its mode", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "hub-perm-"));
    const dir = path.join(tmp, "existing");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    Store.open(path.join(dir, "h.sqlite")).close();
    expect(mode(dir)).toBe(0o755);
    expect(mode(path.join(dir, "h.sqlite"))).toBe(0o600);
  });

  it("created directory becomes 0700", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "hub-perm-"));
    const dir = path.join(tmp, "new", "nested");
    Store.open(path.join(dir, "h.sqlite")).close();
    expect(mode(dir)).toBe(0o700);
    expect(mode(path.join(tmp, "new"))).toBe(0o700);
  });

  it("relative path does not chmod the cwd", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "hub-perm-"));
    chmodSync(tmp, 0o755);
    const prev = process.cwd();
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    process.chdir(tmp);
    try {
      Store.open("hub.sqlite").close();
    } finally {
      process.chdir(prev);
    }
    expect(mode(tmp)).toBe(0o755);
  });
});

describe("production pragmas", () => {
  it("Store.open sets synchronous = NORMAL explicitly", () => {
    // The suite wraps Store.open to run with synchronous = OFF; use the unwrapped original.
    const original = (Store as unknown as Record<symbol, ((p: string) => Store) | undefined>)[
      Symbol.for("sessiondeck.test.original-open")
    ];
    if (!original) throw new Error("fast-sqlite setup did not expose the original Store.open");
    // The level cannot be observed after open: SQLite_DEFAULT_WAL_SYNCHRONOUS=1 in this build
    // drops the connection to NORMAL on its first transaction anyway. Pin the call itself.
    const spy = vi.spyOn(Database.prototype, "pragma");
    tmp = mkdtempSync(path.join(os.tmpdir(), "hub-sync-"));
    const store = original(path.join(tmp, "h.sqlite"));
    try {
      const calls = spy.mock.calls.map((c) => String(c[0]));
      expect(calls).toContain("journal_mode = WAL");
      expect(calls).toContain("synchronous = NORMAL");
      expect(store.db.pragma("synchronous", { simple: true })).toBe(1);
    } finally {
      store.close();
    }
  });
});
