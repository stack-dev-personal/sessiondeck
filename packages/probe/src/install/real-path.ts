import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const toForwardSlash = (p: string): string => p.replace(/\\/g, "/");

/**
 * Absolute path with symlinks and Windows 8.3 short names (C:\Users\RUNNER~1) expanded. The deepest
 * existing ancestor is resolved with realpath.native and the not-yet-existing rest is appended, so
 * a probe home that install has not created yet gets the same spelling it will have afterwards.
 */
export function realResolve(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    const up = dirname(abs);
    if (up === abs) return abs;
    return join(realResolve(up), basename(abs));
  }
}

/** realResolve with forward slashes: the spelling written into settings.json. */
export const realSlash = (p: string): string => toForwardSlash(realResolve(p));
