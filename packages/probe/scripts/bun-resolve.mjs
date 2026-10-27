// Resolves Bun binaries from lockfile-verified bytes only. node_modules/bun/bin is whatever bun's
// postinstall left, and that postinstall can fetch an unchecked binary when the platform package
// is missing or fails `--version`, so it is never trusted by location.
//   1. @oven/bun-<platform>/bin/<bun>: pnpm checked the tarball integrity against the lockfile.
//   2. Windows only: bun's postinstall RENAMES that binary into node_modules/bun/bin/bun.exe (the
//      package bin dir is then empty). That file is accepted only if its SHA-256 equals the pin
//      below, which was taken from the file whose sha512 matched pnpm's store index entry for
//      @oven/bun-windows-x64@1.4.4. Bump the pin with the bun version (test/exe-targets.test.ts
//      fails when they drift apart).
// Pure helpers here (unit tested); build-exe.mjs supplies the filesystem.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const PINNED_BUN_VERSION = "1.4.4";
export const PINNED_WIN32_X64_SHA256 =
  "cb1d8e6564e655e49d30cead359750a1cbbd12f42651caa4b62244d7bd93c244";

const PACKAGES = {
  win32: { pkg: "@oven/bun-windows-x64", bin: "bun.exe" },
  linux: { pkg: "@oven/bun-linux-x64", bin: "bun" },
};

/** Platform package name and binary file for a (platform, arch). Only x64 win32 and linux. */
export function bunPackageFor(platform, arch = "x64") {
  const entry = PACKAGES[platform];
  if (!entry || arch !== "x64") throw new Error(`no pinned bun package for ${platform}-${arch}`);
  return entry;
}

/** Forward-slash path of the bun binary inside an installed platform package directory. */
export function bunBinaryIn(pkgDir, platform, arch = "x64") {
  return join(pkgDir, "bin", bunPackageFor(platform, arch).bin).replaceAll("\\", "/");
}

/**
 * Picks the compiler/base binary for a platform. `pkgDir` is the resolved @oven/bun-<platform>
 * directory, `bunDir` the bun package directory; `exists` and `sha256` read the filesystem.
 * Throws an Error with a user-facing message when no verified binary is available.
 */
export function pickBunBinary({ platform, arch = "x64", pkgDir, bunDir, exists, sha256 }) {
  const { pkg, bin } = bunPackageFor(platform, arch);
  const fromPkg = bunBinaryIn(pkgDir, platform, arch);
  if (exists(fromPkg)) return { path: fromPkg, source: "platform-package" };
  if (platform === "win32") {
    const moved = join(bunDir, "bin", bin).replaceAll("\\", "/");
    if (exists(moved) && sha256(moved) === PINNED_WIN32_X64_SHA256) {
      return { path: moved, source: "pinned-hash" };
    }
  }
  throw new Error(
    `no verified bun binary for ${platform}-${arch}: ${fromPkg} is missing` +
      (platform === "win32" ? " and the postinstall copy does not match the pinned SHA-256" : "") +
      `. Run pnpm install (the lockfile-pinned ${pkg} must be installed); build-exe does not use an unverified bun.`,
  );
}

/**
 * Filesystem side: the verified host compiler (and optionally the Linux exe base) for the probe
 * package at `probeRoot`. Throws Error with a user-facing message; never downloads anything.
 */
export function resolveHostBun(probeRoot, { needLinuxBase = false } = {}) {
  const fromProbe = createRequire(join(probeRoot, "package.json"));
  const bunDir = dirname(fromProbe.resolve("bun/package.json")).replaceAll("\\", "/");
  const fromBun = createRequire(join(bunDir, "package.json"));
  const sha256 = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
  const locate = (platform) => {
    const { pkg } = bunPackageFor(platform, process.arch);
    let pkgDir;
    try {
      pkgDir = dirname(fromBun.resolve(`${pkg}/package.json`));
    } catch (err) {
      throw new Error(`cannot resolve pinned ${pkg}: ${err.message}. Run pnpm install.`);
    }
    return pickBunBinary({
      platform,
      arch: process.arch,
      pkgDir,
      bunDir,
      exists: existsSync,
      sha256,
    }).path;
  };
  return {
    host: locate(process.platform),
    linuxBase: needLinuxBase ? locate("linux") : null,
  };
}
