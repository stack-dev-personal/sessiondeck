import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, RenderError, writeAtomic } from "../sprint/render-prompt.mjs";

const CANARY = "canary: must stay untouched\n";
const PROMPT = "rendered prompt\n";
const GUESSED_PIDS = [process.pid];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sd-render-link-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function failure(run: () => void): RenderError {
  try {
    run();
  } catch (error) {
    expect((error as Error).name).toBe("RenderError");
    return error as RenderError;
  }
  throw new Error("expected writeAtomic to fail");
}

/** A link a non-admin Windows user can create: a junction for directories, else a symlink. */
function tryMakeLink(target: string, path: string, kind: "file" | "junction"): string | undefined {
  try {
    symlinkSync(target, path, kind);
    return undefined;
  } catch (error) {
    return error instanceof Error && "code" in error ? String(error.code) : "unknown";
  }
}

describe("writeAtomic and planted links", () => {
  it("refuses a destination that lstat reports as a link (mocked, runs everywhere)", () => {
    const out = join(dir, "prompt.md");
    const io = { lstat: () => ({ isSymbolicLink: () => true }) };
    const err = failure(() => writeAtomic(out, PROMPT, io));
    expect(err.exitCode).toBe(EXIT.IO);
    expect(err.message).toMatch(/refusing to write .*symbolic link or junction/);
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("writes when lstat reports no destination or a plain file", () => {
    const out = join(dir, "prompt.md");
    const missing = () => {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    };
    writeAtomic(out, PROMPT, { lstat: missing });
    expect(readFileSync(out, "utf8")).toBe(PROMPT);
    writeAtomic(out, `${PROMPT}again\n`, { lstat: () => ({ isSymbolicLink: () => false }) });
    expect(readFileSync(out, "utf8")).toBe(`${PROMPT}again\n`);
  });

  it("surfaces an lstat failure other than ENOENT as a write error", () => {
    const io = {
      lstat: () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    };
    const err = failure(() => writeAtomic(join(dir, "prompt.md"), PROMPT, io));
    expect(err.message).toMatch(/cannot write .*EACCES/);
  });

  it("reports the original write error when the temp cleanup fails too (ENOTDIR on Linux)", () => {
    const attempts: string[] = [];
    const io = {
      lstat: () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
      remove: (path: string) => {
        attempts.push(path);
        throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
      },
    };
    const err = failure(() => writeAtomic(join(dir, "prompt.md"), PROMPT, io));
    expect(attempts).toHaveLength(1);
    expect(err.exitCode).toBe(EXIT.IO);
    expect(err.message).toMatch(/cannot write .*EACCES/);
    expect(err.message).toMatch(/not removed \(ENOTDIR\)/);
  });

  it("does not write through a temp name planted under the old predictable pattern", () => {
    const canary = join(dir, "canary.txt");
    writeFileSync(canary, CANARY);
    const out = join(dir, "prompt.md");
    for (const pid of GUESSED_PIDS) {
      const note = tryMakeLink(canary, join(dir, `.prompt.md.${pid}.tmp`), "file");
      if (note !== undefined) {
        console.warn(`skip planted temp link: cannot create a symlink here (${note})`);
        return;
      }
    }
    writeAtomic(out, PROMPT);
    expect(readFileSync(canary, "utf8")).toBe(CANARY);
    expect(readFileSync(out, "utf8")).toBe(PROMPT);
  });

  it("leaves no temp file behind after a successful write", () => {
    writeAtomic(join(dir, "prompt.md"), PROMPT);
    expect(readdirSync(dir)).toEqual(["prompt.md"]);
  });

  it("refuses a real symlink or junction at the destination and leaves its target alone", () => {
    const canary = join(dir, "canary.txt");
    writeFileSync(canary, CANARY);
    const out = join(dir, "prompt.md");
    const note = tryMakeLink(canary, out, "file");
    if (note !== undefined) {
      console.warn(`skip real file link: cannot create a symlink here (${note})`);
      return;
    }
    const err = failure(() => writeAtomic(out, PROMPT));
    expect(err.message).toMatch(/refusing to write/);
    expect(readFileSync(canary, "utf8")).toBe(CANARY);
  });

  it("refuses a real junction at the destination and leaves its target alone", () => {
    const targetDir = join(dir, "elsewhere");
    mkdirSync(targetDir);
    writeFileSync(join(targetDir, "keep.txt"), CANARY);
    const out = join(dir, "linked-dir");
    const note = tryMakeLink(targetDir, out, "junction");
    if (note !== undefined) {
      console.warn(`skip real junction: cannot create a link here (${note})`);
      return;
    }
    const err = failure(() => writeAtomic(out, PROMPT));
    expect(err.message).toMatch(/refusing to write/);
    expect(readdirSync(targetDir)).toEqual(["keep.txt"]);
    expect(readFileSync(join(targetDir, "keep.txt"), "utf8")).toBe(CANARY);
  });
});
