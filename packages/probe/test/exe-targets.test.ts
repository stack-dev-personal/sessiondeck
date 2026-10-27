import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PINNED_BUN_VERSION,
  PINNED_WIN32_X64_SHA256,
  bunPackageFor,
  pickBunBinary,
} from "../scripts/bun-resolve.mjs";
import { AUTOLOAD_OFF_FLAGS } from "../scripts/exe-flags.mjs";
import { selectTargets } from "../scripts/exe-targets.mjs";
import { probeRoot } from "./helpers.ts";

const dirs = (p: string, hostOnly = false) =>
  selectTargets(p, { hostOnly }).targets.map((t) => `${t.dir}${t.cross ? ":cross" : ""}`);

describe("selectTargets", () => {
  it("win32 builds windows native and linux cross, with the floor", () => {
    expect(dirs("win32")).toEqual(["windows-x64", "linux-x64:cross"]);
    expect(selectTargets("win32").includeFloor).toBe(true);
  });
  it("win32 --host-only builds windows only, no floor", () => {
    expect(dirs("win32", true)).toEqual(["windows-x64"]);
    expect(selectTargets("win32", { hostOnly: true }).includeFloor).toBe(false);
  });
  it("linux builds linux native only and prints a skip notice", () => {
    const r = selectTargets("linux");
    expect(dirs("linux")).toEqual(["linux-x64"]);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toContain("skipping windows-x64");
    expect(r.includeFloor).toBe(true);
  });
  it("linux --host-only is the same target without the floor", () => {
    expect(dirs("linux", true)).toEqual(["linux-x64"]);
    expect(selectTargets("linux", { hostOnly: true }).includeFloor).toBe(false);
  });
  it("never marks a native target as cross", () => {
    for (const p of ["win32", "linux"]) {
      const native = selectTargets(p).targets.filter((t) => !t.cross);
      expect(native).toHaveLength(1);
    }
  });
  it("rejects unsupported hosts", () => {
    expect(() => selectTargets("darwin")).toThrow(/unsupported/);
  });
});

describe("pickBunBinary (compiler comes from lockfile-verified bytes only)", () => {
  const pkgDir = "C:/store/@oven/bun-windows-x64";
  const bunDir = "C:/repo/node_modules/bun";
  const pick = (platform: string, files: Record<string, string>) =>
    pickBunBinary({
      platform,
      pkgDir: platform === "win32" ? pkgDir : "/store/@oven/bun-linux-x64",
      bunDir,
      exists: (p) => p in files,
      sha256: (p) => files[p] ?? "",
    });

  it("win32 prefers the platform package binary", () => {
    const r = pick("win32", { [`${pkgDir}/bin/bun.exe`]: "x", [`${bunDir}/bin/bun.exe`]: "bad" });
    expect(r).toEqual({ path: `${pkgDir}/bin/bun.exe`, source: "platform-package" });
  });
  it("win32 accepts the postinstall copy only when its SHA-256 is the pin", () => {
    const ok = pick("win32", { [`${bunDir}/bin/bun.exe`]: PINNED_WIN32_X64_SHA256 });
    expect(ok.source).toBe("pinned-hash");
    expect(() => pick("win32", { [`${bunDir}/bin/bun.exe`]: "f".repeat(64) })).toThrow(
      /pinned SHA-256/,
    );
  });
  it("win32 with nothing installed fails and names pnpm install", () => {
    expect(() => pick("win32", {})).toThrow(/pnpm install/);
  });
  it("linux uses the platform package only, never node_modules/bun/bin", () => {
    const r = pick("linux", { "/store/@oven/bun-linux-x64/bin/bun": "x" });
    expect(r).toEqual({ path: "/store/@oven/bun-linux-x64/bin/bun", source: "platform-package" });
    expect(() => pick("linux", { [`${bunDir}/bin/bun`]: "x" })).toThrow(/no verified bun binary/);
  });
  it("rejects unsupported platforms and arches", () => {
    expect(() => bunPackageFor("darwin", "arm64")).toThrow();
    expect(() => bunPackageFor("linux", "arm64")).toThrow();
  });
  it("the pin tracks the bun version in package.json", () => {
    const pkg = JSON.parse(readFileSync(join(probeRoot, "package.json"), "utf8"));
    expect(pkg.devDependencies.bun).toBe(PINNED_BUN_VERSION);
  });
});

describe("AUTOLOAD_OFF_FLAGS", () => {
  it("turns off dotenv, bunfig, tsconfig and package.json autoload", () => {
    expect([...AUTOLOAD_OFF_FLAGS].sort()).toEqual([
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-package-json",
      "--no-compile-autoload-tsconfig",
    ]);
  });
});
