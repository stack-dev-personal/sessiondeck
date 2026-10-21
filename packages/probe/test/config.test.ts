import {
  ConfigError,
  currentUserSid,
  resolveSystemExe,
  restrictWindowsAcl,
  validateUserSid,
  type SysDeps,
} from "../src/config/config.ts";
import { describe, expect, it } from "vitest";

describe("windows ACL helpers are pinned to System32 (review round 3)", () => {
  const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
  function deps(over: Partial<SysDeps> & { whoami?: string } = {}) {
    const calls: { file: string; args: string[]; cwd: string; timeout: number }[] = [];
    const d: SysDeps = {
      env: { SystemRoot: "D:\\Win" },
      exists: () => true,
      run: (file, args, o) => {
        calls.push({ file, args, cwd: o.cwd, timeout: o.timeout });
        return file.endsWith("whoami.exe") ? (over.whoami ?? `"PC\\u","${SID}"\r\n`) : "";
      },
      ...over,
    };
    return { d, calls };
  }

  it("resolves whoami and icacls to <SystemRoot>\\System32 with that cwd and a timeout", () => {
    const { d, calls } = deps();
    restrictWindowsAcl("C:\\h\\probe.json", d);
    expect(calls.map((c) => c.file)).toEqual([
      "D:\\Win\\System32\\whoami.exe",
      "D:\\Win\\System32\\icacls.exe",
      "D:\\Win\\System32\\icacls.exe",
    ]);
    for (const c of calls) {
      expect(c.cwd).toBe("D:\\Win\\System32");
      expect(c.timeout).toBeGreaterThan(0);
    }
    expect(calls[1]?.args).toEqual([
      "C:\\h\\probe.json",
      "/inheritance:r",
      "/grant:r",
      `*${SID}:F`,
    ]);
    expect(calls[2]?.args).toEqual([
      "C:\\h\\probe.json",
      "/remove:g",
      "*S-1-5-18",
      "*S-1-5-32-544",
      "*S-1-3-4",
    ]);
  });

  it("an invalid SystemRoot falls back to C:\\Windows; a missing exe is an error", () => {
    const bad = deps({ env: { SystemRoot: "..\\evil" } });
    expect(resolveSystemExe("whoami.exe", bad.d).exe).toBe("C:\\Windows\\System32\\whoami.exe");
    expect(() => resolveSystemExe("whoami.exe", { env: {}, exists: () => false })).toThrow();
  });

  it("refuses well-known group SIDs before icacls runs", () => {
    for (const sid of ["S-1-1-0", "S-1-5-11", "S-1-5-32-545", "S-1-5-18", "S-1-5-21-"]) {
      expect(() => validateUserSid(sid), sid).toThrow();
    }
    expect(validateUserSid(SID)).toBe(SID);
    const { d, calls } = deps({ whoami: '"PC\\u","S-1-1-0"\r\n' });
    expect(() => currentUserSid(d)).toThrow();
    expect(() => restrictWindowsAcl("C:\\h\\probe.json", d)).toThrow(ConfigError);
    expect(calls.every((c) => c.file.endsWith("whoami.exe"))).toBe(true);
  });

  it("accepts Entra ID (S-1-12-1-...) and domain SIDs, refuses odd shapes", () => {
    const entra = "S-1-12-1-1234567890-1234567890-1234567890-1234567890";
    expect(validateUserSid(entra)).toBe(entra);
    const { d, calls } = deps({ whoami: `"AzureAD\\Ann","${entra}"\r\n` });
    expect(currentUserSid(d)).toBe(entra);
    restrictWindowsAcl("C:\\h\\probe.json", d);
    expect(calls.at(-2)?.args).toContain(`*${entra}:F`);
    for (const sid of ["S-1-12-1-", "S-1-12-2-1-2", "S-1-5-21-abc", "S-1-12-1", "S-1-5-21-1--2"]) {
      expect(() => validateUserSid(sid), sid).toThrow();
    }
  });

  it("does nothing when whoami.exe is not in System32 (no bare-name fallback)", () => {
    const { d, calls } = deps({ exists: () => false });
    expect(() => restrictWindowsAcl("C:\\h\\probe.json", d)).toThrow(ConfigError);
    expect(calls).toEqual([]);
  });
});
