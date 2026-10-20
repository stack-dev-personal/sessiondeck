import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import {
  ConfigError,
  currentUserSid,
  resolveSystemExe,
  restrictWindowsAcl,
  validateUserSid,
  type SysDeps,
} from "../src/config/config.ts";
import { resolveHostName } from "../src/host.ts";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harnessFixture, readJson, readText, runCli, sandbox } from "./fixtures/sandbox.ts";

const TOKEN = "tok_Zx9-very-secret-0123456789";
const win32 = process.platform === "win32";

async function installWithToken(sb = sandbox(harnessFixture)) {
  const tokenFile = join(sb.root, "token.txt");
  writeFileSync(tokenFile, `${TOKEN}\n`);
  const r = await runCli(
    ["install", "--hub", "http://127.0.0.1:8787", "--token-file", tokenFile],
    sb.env,
  );
  return { sb, r, tokenFile };
}

describe("probe config (R1.10)", () => {
  it("writes probe.json outside the settings directory; the token is nowhere else", async () => {
    const { sb, r } = await installWithToken();
    expect(r.code, r.stderr).toBe(0);
    const cfgPath = join(sb.home, "probe.json");
    expect(cfgPath.startsWith(sb.configDir)).toBe(false);
    expect(readJson(cfgPath)).toEqual({
      hubUrl: "http://127.0.0.1:8787",
      token: TOKEN,
      host: resolveHostName(),
    });
    expect(readText(sb.settings)).not.toContain(TOKEN);
    expect(readText(join(sb.home, "install-state.json"))).not.toContain(TOKEN);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  it.skipIf(win32)("probe.json is 0600 and the probe home is 0700 on POSIX", async () => {
    const { sb } = await installWithToken();
    expect(statSync(join(sb.home, "probe.json")).mode & 0o777).toBe(0o600);
    expect(statSync(sb.home).mode & 0o777).toBe(0o700);
  });

  it.skipIf(win32)("a rewrite keeps 0600", async () => {
    const { sb } = await installWithToken();
    await runCli(["install", "--hub", "http://127.0.0.1:9999"], sb.env);
    expect(statSync(join(sb.home, "probe.json")).mode & 0o777).toBe(0o600);
  });

  it.skipIf(win32)("a rerun that changes nothing still fixes a 0644 probe.json", async () => {
    const { sb } = await installWithToken();
    chmodSync(join(sb.home, "probe.json"), 0o644);
    const r = await runCli(["install"], sb.env);
    expect(r.code, r.stderr).toBe(0);
    expect(statSync(join(sb.home, "probe.json")).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!win32)("probe.json ACL grants only the current user (icacls)", async () => {
    const { sb } = await installWithToken();
    const out = execFileSync("icacls", [join(sb.home, "probe.json")], {
      encoding: "utf8",
      windowsHide: true,
    });
    const user = (process.env["USERNAME"] ?? userInfo().username).toLowerCase();
    const aces = out
      .split(/\r?\n/)
      .filter((l) => /:\(/.test(l))
      .map((l) => l.toLowerCase());
    expect(aces.length).toBeGreaterThan(0);
    for (const ace of aces) {
      expect(ace).toContain(user);
      expect(ace).not.toMatch(/everyone|builtin\\users|authenticated users/);
    }
  });

  it("re-install keeps the token unless a new one is given", async () => {
    const { sb } = await installWithToken();
    await runCli(["install"], sb.env);
    expect(readJson(join(sb.home, "probe.json")).token).toBe(TOKEN);
    const r = await runCli(["install", "--token-stdin"], sb.env, "tok_second_0987654321\n");
    expect(r.code, r.stderr).toBe(0);
    expect(readJson(join(sb.home, "probe.json")).token).toBe("tok_second_0987654321");
    expect(r.stdout + r.stderr).not.toContain("tok_second");
  });

  it("rejects the token as an argument, without echoing it, and writes nothing", async () => {
    const sb = sandbox(harnessFixture);
    for (const args of [["--token", TOKEN], [`--token=${TOKEN}`]]) {
      const r = await runCli(["install", ...args], sb.env);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/not accepted as an argument/);
      expect(r.stdout + r.stderr).not.toContain(TOKEN);
    }
    expect(existsSync(sb.home)).toBe(false);
    expect(readText(sb.settings)).not.toContain("sessiondeck-probe");
  });

  it("config show masks the token; no command prints it", async () => {
    const { sb } = await installWithToken();
    const show = await runCli(["config", "show"], sb.env);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("********");
    expect(show.stdout).toContain("http://127.0.0.1:8787");
    const outs = [show];
    outs.push(await runCli(["uninstall"], sb.env), await runCli(["--help"], sb.env));
    outs.push(await runCli(["install", "--hub", "not a url"], sb.env));
    for (const o of outs) expect(o.stdout + o.stderr).not.toContain(TOKEN);
  });

  it("uninstall leaves probe.json; --purge removes it", async () => {
    const { sb } = await installWithToken();
    await runCli(["uninstall"], sb.env);
    expect(existsSync(join(sb.home, "probe.json"))).toBe(true);
    await runCli(["uninstall", "--purge"], sb.env);
    expect(existsSync(join(sb.home, "probe.json"))).toBe(false);
  });

  it("rejects a bad hub URL and an empty token file", async () => {
    const sb = sandbox(harnessFixture);
    const empty = join(sb.root, "empty.txt");
    writeFileSync(empty, "\n");
    expect((await runCli(["install", "--hub", "ftp://x"], sb.env)).code).toBe(1);
    expect((await runCli(["install", "--token-file", empty], sb.env)).code).toBe(1);
    expect((await runCli(["install", "--token-file", join(sb.root, "nope")], sb.env)).code).toBe(1);
  });

  it("never leaves the token in the registered hook args", async () => {
    const { sb } = await installWithToken();
    const hooks = JSON.stringify(readJson(sb.settings).hooks);
    expect(hooks).not.toContain(TOKEN);
    expect(hooks).not.toContain("probe.json");
  });
});

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

  it("does nothing when whoami.exe is not in System32 (no bare-name fallback)", () => {
    const { d, calls } = deps({ exists: () => false });
    expect(() => restrictWindowsAcl("C:\\h\\probe.json", d)).toThrow(ConfigError);
    expect(calls).toEqual([]);
  });
});
