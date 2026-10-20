// Ported from sirmalloc/ccstatusline src/utils/windows-code-page.ts @ 3d94211 (MIT)
// Copyright (c) 2025 Matthew Breedlove
// Changes: standalone function with an injectable platform and runner for tests; no
//   executable-resolution helper (chcp.com is looked up on PATH by execFileSync); failures swallowed.
import { execFileSync } from "node:child_process";

/**
 * Switches the console code page to UTF-8 (65001) so non-ASCII output survives on Windows.
 * No-op elsewhere. Failures are ignored to preserve statusline output even in restricted shells.
 */
export function setWindowsUtf8(
  platform: NodeJS.Platform = process.platform,
  run: (file: string, args: string[]) => unknown = (file, args) =>
    execFileSync(file, args, { stdio: "ignore", windowsHide: true }),
): void {
  if (platform !== "win32") return;
  try {
    run("chcp.com", ["65001"]);
  } catch {
    // ignore
  }
}
