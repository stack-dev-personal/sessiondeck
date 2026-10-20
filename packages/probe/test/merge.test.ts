import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { applyInstall, type Ctx, type InstallEntry } from "../src/install/merge.ts";
import { buildCtx, isShellSafe } from "../src/install/run.ts";
import { realResolve, realSlash } from "../src/install/real-path.ts";

const ctxFor = (statusline?: string): Ctx => ({
  hookPath: "/a/dist/hook.mjs",
  home: "/h",
  host: "t",
  ...(statusline === undefined
    ? { statusSkipReason: "unsafe" }
    : { statuslineCommand: statusline, subagentsCommand: `${statusline} sub` }),
});
const none = { replaceStatus: false };

describe("install skips unsafe status commands without leaving a stale entry (review round 2)", () => {
  it("installing first from a safe path, then from an unsafe one, removes our old statusLine", () => {
    const first = applyInstall(
      {},
      ctxFor("node /safe/statusline.mjs --sessiondeck-probe"),
      undefined,
      true,
      none,
    );
    expect(first.settings["statusLine"]).toBeDefined();
    expect(first.settings["subagentStatusLine"]).toBeDefined();
    const second = applyInstall(first.settings, ctxFor(undefined), first.entry, true, none);
    expect(second.settings["statusLine"]).toBeUndefined();
    expect(second.settings["subagentStatusLine"]).toBeUndefined();
    expect(second.notices.some((n) => n.includes("removed the entry"))).toBe(true);
    expect(JSON.stringify(second.settings)).not.toContain("/safe/");
  });
  it("keeps the recorded previous value so a later safe install and uninstall can restore it", () => {
    const mine = { type: "command", command: "bash /home/u/line.sh" };
    const first = applyInstall(
      { statusLine: mine },
      ctxFor("node /safe/statusline.mjs --sessiondeck-probe"),
      undefined,
      true,
      { replaceStatus: true },
    );
    expect(first.entry.previous.statusLine).toEqual({ present: true, value: mine });
    const second = applyInstall(first.settings, ctxFor(undefined), first.entry, true, none);
    expect(second.settings["statusLine"]).toBeUndefined();
    expect(second.entry.previous.statusLine).toEqual({ present: true, value: mine });
    const third = applyInstall(
      second.settings,
      ctxFor("node /other/statusline.mjs --sessiondeck-probe"),
      second.entry,
      true,
      none,
    );
    expect(third.entry.previous.statusLine).toEqual({ present: true, value: mine });
    expect((third.settings["statusLine"] as { command: string }).command).toContain("/other/");
  });
  it("leaves a foreign statusLine alone when the command is skipped", () => {
    const foreign = { type: "command", command: "bash /home/u/line.sh" };
    const r = applyInstall({ statusLine: foreign }, ctxFor(undefined), undefined, true, none);
    expect(r.settings["statusLine"]).toEqual(foreign);
  });
});

describe("shell-safe words and real paths (windows CI)", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("allows ~ inside a word (8.3 short names, a~b) but not at the start", () => {
    expect(isShellSafe("C:/Users/RUNNER~1/AppData/Local/Temp/x")).toBe(true);
    expect(isShellSafe("/tmp/a~b/dist")).toBe(true);
    expect(isShellSafe("~/dist")).toBe(false);
    expect(isShellSafe("~")).toBe(false);
    expect(isShellSafe("/tmp/a b%c")).toBe(false);
  });
  it("buildCtx keeps the status commands for a path with ~ in the middle", () => {
    const root = mkdtempSync(join(tmpdir(), "sd-tilde~1-"));
    dirs.push(root);
    const ctx = buildCtx(join(root, "dist"), join(root, "home"), "t");
    expect(ctx.statuslineCommand).toContain("statusline.mjs");
    expect(ctx.statusSkipReason).toBeUndefined();
  });
  it("buildCtx writes the realpath spelling (symlinks expanded; missing tail kept)", () => {
    const root = mkdtempSync(join(tmpdir(), "sd-real-"));
    dirs.push(root);
    const real = join(root, "real");
    mkdirSync(real);
    const link = join(root, "link");
    try {
      symlinkSync(real, link, "dir");
    } catch {
      return;
    }
    const ctx = buildCtx(join(link, "dist"), join(link, "not-yet", "home"), "t");
    expect(ctx.hookPath).toBe(`${realSlash(real)}/dist/hook.mjs`);
    expect(ctx.home).toBe(`${realSlash(real)}/not-yet/home`);
    expect(realResolve(join(link, "x", "y"))).toBe(join(realResolve(real), "x", "y"));
  });
});

describe("entry type", () => {
  it("InstallEntry is what applyInstall returns", () => {
    const e: InstallEntry = applyInstall({}, ctxFor(undefined), undefined, false, none).entry;
    expect(e.createdFile).toBe(true);
  });
});
