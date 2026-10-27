export const PINNED_BUN_VERSION: string;
export const PINNED_WIN32_X64_SHA256: string;
export function bunPackageFor(platform: string, arch?: string): { pkg: string; bin: string };
export function bunBinaryIn(pkgDir: string, platform: string, arch?: string): string;
export function pickBunBinary(o: {
  platform: string;
  arch?: string;
  pkgDir: string;
  bunDir: string;
  exists: (p: string) => boolean;
  sha256: (p: string) => string;
}): { path: string; source: "platform-package" | "pinned-hash" };
export function resolveHostBun(
  probeRoot: string,
  o?: { needLinuxBase?: boolean },
): { host: string; linuxBase: string | null };
