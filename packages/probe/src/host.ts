import { readFileSync } from "node:fs";
import { hostname } from "node:os";

/** True inside WSL2: /proc/version mentions "microsoft" (case-insensitive). Linux only. */
export function isWsl(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "linux") return false;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/** Host name for envelopes: os.hostname(), plus "-wsl" inside WSL2 so it differs from Windows. */
export function resolveHostName(): string {
  return `${hostname()}${isWsl() ? "-wsl" : ""}`;
}
