// `probe daemon install|uninstall` against the real OS, through the built CLI (dist/probe.mjs).
// Windows: registers a uniquely named per-user task as the current user (the windows-latest runner
// is admin, so this proves the task shape, not non-admin registration: see D-S2-7), queries it
// and unregisters it in finally. Linux: the unit file and the no-user-bus path, with HOME in a temp
// dir; skipped when the host has a working `systemctl --user` (it would act on a real manager).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { launcherScript, utf16leBom } from "../src/autostart/windows.ts";
import { probeRoot } from "./helpers.ts";

const cli = join(probeRoot, "dist", "probe.mjs");
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...env },
  });

const winOnly = process.platform === "win32" ? it : it.skip;

describe("windows Task Scheduler (real)", () => {
  winOnly("registers a logon task for the current user, Limited, and removes it", () => {
    const name = `SessionDeckTest-${process.pid}-${Date.now()}`;
    // Windows only accepts a home inside the user's default probe home (no ACL on other folders).
    const base = join(homedir(), "AppData", "Local", "sessiondeck");
    mkdirSync(base, { recursive: true });
    const home = mkdtempSync(join(base, "test-task-"));
    const schtasks = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "schtasks.exe");
    try {
      const a = run(["daemon", "install", "--home", home, "--task-name", name, "--no-start"]);
      expect(a.status, a.stderr).toBe(0);
      // idempotent: a second install replaces the task, it does not add one
      const b = run(["daemon", "install", "--home", home, "--task-name", name, "--no-start"]);
      expect(b.status, b.stderr).toBe(0);
      const list = spawnSync(schtasks, ["/Query", "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        windowsHide: true,
      });
      expect(list.stdout.split(name).length - 1).toBe(1);

      const q = spawnSync(schtasks, ["/Query", "/TN", name, "/XML"], {
        encoding: "utf8",
        windowsHide: true,
      });
      expect(q.status, q.stderr).toBe(0);
      const xml = q.stdout;
      const user = `${process.env["USERDOMAIN"]}\\${process.env["USERNAME"]}`;
      const who = spawnSync(join(dirname(schtasks), "whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
        encoding: "utf8",
        windowsHide: true,
      });
      const sid = (/"(S-1-[\d-]+)"\s*$/m.exec(who.stdout.trim()) ?? [])[1] ?? "";
      expect(sid, who.stdout + who.stderr).not.toBe("");
      const section = (tag: string): string =>
        new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? "";
      const userIdOf = (tag: string): string =>
        (/<UserId>([^<]*)<\/UserId>/.exec(section(tag)) ?? [])[1]?.toLowerCase() ?? "";
      expect(xml).toContain("<LogonTrigger>");
      expect(userIdOf("LogonTrigger")).toBe(user.toLowerCase());
      // the export shows the principal as a SID (or DOMAIN\user)
      expect([user.toLowerCase(), sid.toLowerCase()]).toContain(userIdOf("Principal"));
      // Limited is the default and the export omits <RunLevel> for it; only HighestAvailable is wrong
      expect(xml).not.toContain("<RunLevel>HighestAvailable</RunLevel>");
      expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
      expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
      expect(xml).toContain("<RestartOnFailure>");
      expect(xml.toLowerCase()).toContain("wscript.exe");
      expect(existsSync(join(home, "launch-daemon.vbs"))).toBe(true);
      expect(existsSync(join(home, "daemon-task.xml"))).toBe(false);

      const u = run(["daemon", "uninstall", "--home", home, "--task-name", name]);
      expect(u.status, u.stderr).toBe(0);
      const gone = spawnSync(schtasks, ["/Query", "/TN", name], { windowsHide: true });
      expect(gone.status).not.toBe(0);
      expect(existsSync(join(home, "launch-daemon.vbs"))).toBe(false);
      // uninstall when absent is a success
      const again = run(["daemon", "uninstall", "--home", home, "--task-name", name]);
      expect(again.status, again.stderr).toBe(0);
    } finally {
      spawnSync(schtasks, ["/Delete", "/TN", name, "/F"], { windowsHide: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("windows launcher restart (real wscript)", () => {
  winOnly("restarts a daemon that exits non-zero and stops when it exits 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "sd-launch-"));
    try {
      const counter = join(dir, "runs.txt");
      const fake = join(dir, "fake-daemon.mjs");
      // fails twice (as a crash would), then exits 0
      writeFileSync(
        fake,
        `import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(counter)}, "x");
process.exit(readFileSync(${JSON.stringify(counter)}, "utf8").length >= 3 ? 0 : 1);`,
      );
      const vbs = join(dir, "launch-daemon.vbs");
      writeFileSync(
        vbs,
        utf16leBom(
          launcherScript(
            { node: process.execPath, script: fake, probeHome: dir },
            { initialDelayMs: 200 },
          ),
        ),
      );
      const wscript = join("C:\\Windows", "System32", "wscript.exe");
      const r = spawnSync(wscript, ["//B", "//Nologo", vbs], {
        windowsHide: true,
        timeout: 30_000,
      });
      expect(r.status).toBe(0);
      expect(readFileSync(counter, "utf8")).toBe("xxx");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const busWorks = (): boolean => {
  const r = spawnSync("systemctl", ["--user", "show-environment"], { windowsHide: true });
  return r.status === 0;
};
const linuxNoBus = process.platform === "linux" && !busWorks() ? it : it.skip;

describe("systemd user unit (real files, no user bus)", () => {
  linuxNoBus("writes the unit, prints how to start it, exits 0; uninstall removes it", () => {
    const home = mkdtempSync(join(tmpdir(), "sd-unit-home-"));
    try {
      const env = { HOME: home };
      const a = run(["daemon", "install", "--home", join(home, "state")], env);
      expect(a.status, a.stderr).toBe(0);
      const unit = join(home, ".config", "systemd", "user", "sessiondeck-probe.service");
      const text = readFileSync(unit, "utf8");
      expect(text).toContain("Restart=on-failure");
      expect(text).toContain(`"${process.execPath}"`);
      expect(text).toContain(`"${join(probeRoot, "dist", "daemon.mjs")}"`);
      expect(a.stdout).toContain("systemctl --user enable --now sessiondeck-probe.service");
      const u = run(["daemon", "uninstall", "--home", join(home, "state")], env);
      expect(u.status, u.stderr).toBe(0);
      expect(existsSync(unit)).toBe(false);
      expect(run(["daemon", "uninstall"], env).status).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
