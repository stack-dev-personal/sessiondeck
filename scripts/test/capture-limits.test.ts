import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { recordBytes, usedBytes } from "../lib/capture-budget.mjs";
import {
  OUT_MAX_TOTAL_BYTES,
  STALE_TEMP_MS,
  STATE_MAX_FILES,
  UNPARSED_MAX_BYTES,
} from "../lib/capture-config.mjs";
import { captureOnce, truncateUtf8 } from "../lib/capture-core.mjs";
import { countEntries, writeInside } from "../lib/capture-store.mjs";
import { CAPTURE_SCRIPT, cleanupTempDirs, listTree, makeTempDir, runScript } from "./helpers";

afterAll(cleanupTempDirs);

const NOW = 1_700_000_000_000;
const stop = (extra = {}) =>
  JSON.stringify({ hook_event_name: "Stop", session_id: "s1", ...extra });
const hook = (out: string, text: string) =>
  captureOnce({ mode: "hook", out, text, truncated: false, now: NOW });

describe("byte budget", () => {
  it("records each stored payload size in a running log", async () => {
    const out = join(makeTempDir(), "out");
    await hook(out, stop());
    await hook(out, stop());
    expect(await usedBytes(out)).toBe(2 * Buffer.byteLength(stop()));
  });

  it("stops storing once the total would pass the budget", async () => {
    const out = join(makeTempDir(), "out");
    mkdirSync(out);
    await recordBytes(out, OUT_MAX_TOTAL_BYTES - 10);
    await hook(out, stop());
    expect(existsSync(join(out, "Stop"))).toBe(false);
  });

  it("an empty or missing log counts as zero", async () => {
    expect(await usedBytes(join(makeTempDir(), "nothing"))).toBe(0);
  });
});

describe("stored text and directories are bounded", () => {
  it("cuts unparsed input to the named limit", async () => {
    const out = join(makeTempDir(), "out");
    await hook(out, "x".repeat(1024 * 1024));
    const [file] = readdirSync(join(out, "_unparsed"));
    expect(statSync(join(out, "_unparsed", file!)).size).toBe(UNPARSED_MAX_BYTES);
  });

  it("truncateUtf8 never exceeds the byte limit and leaves short text alone", () => {
    expect(truncateUtf8("abc", 10)).toBe("abc");
    expect(Buffer.byteLength(truncateUtf8("é".repeat(100), 51))).toBeLessThanOrEqual(53);
  });

  it("stops adding throttle state files past the cap but keeps updating existing ones", async () => {
    const out = join(makeTempDir(), "out");
    mkdirSync(join(out, "_state"), { recursive: true });
    for (let i = 0; i < STATE_MAX_FILES; i++)
      writeFileSync(join(out, "_state", `f${i}.json`), "{}");
    const status = JSON.stringify({ session_id: "brand-new", model: {} });
    await captureOnce({ mode: "statusline", out, text: status, truncated: false, now: NOW });
    expect(readdirSync(join(out, "_state"))).toHaveLength(STATE_MAX_FILES);
  });

  it("removes stale temp files, keeps fresh ones, and does not count either", async () => {
    const dir = join(makeTempDir(), "Stop");
    mkdirSync(dir);
    const stale = join(dir, ".tmp-aaaaaaaaaaaa");
    const fresh = join(dir, ".tmp-bbbbbbbbbbbb");
    writeFileSync(stale, "x");
    writeFileSync(fresh, "x");
    writeFileSync(join(dir, "1-a-b.json"), "{}");
    const old = new Date(Date.now() - STALE_TEMP_MS - 60_000);
    utimesSync(stale, old, old);
    expect(await countEntries(dir)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe("containment", () => {
  it("a junction or symlink at <out>/Stop cannot lead outside the out dir", async (ctx) => {
    const sandbox = makeTempDir();
    const out = join(sandbox, "out");
    const outside = join(sandbox, "outside");
    mkdirSync(out);
    mkdirSync(outside);
    try {
      symlinkSync(outside, join(out, "Stop"), "junction");
    } catch (error) {
      ctx.skip(`cannot create a junction or symlink here: ${String(error)}`);
      return;
    }
    await expect(hook(out, stop())).rejects.toThrow(/escaped/);
    expect(readdirSync(outside)).toEqual([]);
    await expect(writeInside(out, "Stop", "x.json", "{}")).rejects.toThrow(/escaped/);
    expect(listTree(outside)).toEqual([]);
  });
});

describe("--out handling in the hook", () => {
  it("--out without a value writes nothing, even when SESSIONDECK_CAPTURE_DIR is set", async () => {
    const sandbox = makeTempDir();
    const fallback = join(sandbox, "fallback");
    for (const args of [["--out"], ["--out", "--statusline"]]) {
      const r = await runScript(CAPTURE_SCRIPT, args, {
        sandbox,
        input: stop(),
        env: { SESSIONDECK_CAPTURE_DIR: fallback },
      });
      expect(r.code).toBe(0);
      expect(r.stderr).toBe("");
    }
    expect(listTree(sandbox)).toEqual([]);
  });

  it("without --out or the env var nothing is written", async () => {
    const sandbox = makeTempDir();
    const r = await runScript(CAPTURE_SCRIPT, [], { sandbox, input: stop() });
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
    expect(listTree(sandbox)).toEqual([]);
  });

  it("ignores --marker", async () => {
    const sandbox = makeTempDir();
    const out = join(sandbox, "out");
    const r = await runScript(CAPTURE_SCRIPT, ["--marker", "sessiondeck-capture", "--out", out], {
      sandbox,
      input: stop(),
    });
    expect(r.code).toBe(0);
    expect(readFileSync(join(out, ".gitignore"), "utf8")).toBe("*\n");
    expect(readdirSync(join(out, "Stop"))).toHaveLength(1);
  });
});
