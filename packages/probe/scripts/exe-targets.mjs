// Pure target selection for build-exe.mjs (unit tested in test/exe-targets.test.ts).
// win32: windows-x64 native, plus linux-x64 cross-compiled from a pinned local base unless hostOnly.
// linux: linux-x64 native only; windows-x64 is skipped with a notice (no Windows base is installed
//   there and bun would download one).
// Any other platform is unsupported. A non-native target always has cross:true, which the builder
// must satisfy with --compile-executable-path to a lockfile-pinned local base, never a download.
// The bun-floor exe is bench-only and is excluded when hostOnly is set.
export function selectTargets(platform, { hostOnly = false } = {}) {
  const win = { dir: "windows-x64", ext: ".exe", cross: platform !== "win32" };
  const linux = { dir: "linux-x64", ext: "", cross: platform !== "linux" };
  const notices = [];
  let targets;
  if (platform === "win32") {
    targets = hostOnly ? [win] : [win, linux];
  } else if (platform === "linux") {
    targets = [linux];
    notices.push("build-exe: skipping windows-x64 on a linux host (no pinned windows base here)");
  } else {
    throw new Error(`unsupported build host platform: ${platform}`);
  }
  return { targets, notices, includeFloor: !hostOnly };
}
