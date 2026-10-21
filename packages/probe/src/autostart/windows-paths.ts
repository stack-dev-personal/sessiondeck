// Fixed System32 binaries for the Windows autostart (no environment lookup; see system32()).
import { win32 } from "node:path";
import { type AutostartEnv } from "./types.ts";

const WINDOWS_ROOT = "C:\\Windows";

/**
 * System32 comes from the OS default, never from the environment: a repo-controlled "env" in
 * .claude/settings.json could otherwise point SystemRoot at a directory holding a planted
 * wscript.exe that the task would then run at every logon. An environment value is accepted only
 * when it names C:\\Windows (case-insensitive); anything else is refused.
 */
export function system32(e: AutostartEnv, exe: string): string {
  for (const key of ["SystemRoot", "SYSTEMROOT", "windir", "WINDIR"]) {
    const v = e.env[key];
    if (v === undefined || v === "") continue;
    const norm = v.replace(/[\\/]+$/, "").replace(/\//g, "\\");
    if (norm.toLowerCase() !== WINDOWS_ROOT.toLowerCase()) {
      throw new Error(
        `${key} is ${JSON.stringify(v)}, not ${WINDOWS_ROOT}; refusing to run or register binaries from there. Only a Windows installed in ${WINDOWS_ROOT} is supported (an environment variable is not trusted to name the system directory); use \`probe daemon run\` instead`,
      );
    }
  }
  return win32.join(WINDOWS_ROOT, "System32", exe);
}

export const schtasksPath = (e: AutostartEnv): string => system32(e, "schtasks.exe");
export const wscriptPath = (e: AutostartEnv): string => system32(e, "wscript.exe");
