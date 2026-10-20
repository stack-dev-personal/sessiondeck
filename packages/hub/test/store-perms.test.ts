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
