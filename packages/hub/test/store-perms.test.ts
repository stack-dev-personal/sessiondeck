import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("a fresh file database opens with synchronous = NORMAL (1), not FULL", () => {
    // The suite wraps Store.open to run with synchronous = OFF; use the unwrapped original.
    const original = (Store as unknown as Record<symbol, (p: string) => Store>)[
      Symbol.for("sessiondeck.test.original-open")
    ];
    expect(original).toBeTypeOf("function");
    tmp = mkdtempSync(path.join(os.tmpdir(), "hub-sync-"));
    const store = original(path.join(tmp, "h.sqlite"));
    try {
      expect(store.db.pragma("synchronous", { simple: true })).toBe(1);
      expect(store.db.pragma("journal_mode", { simple: true })).toBe("wal");
    } finally {
      store.close();
    }
  });
});
