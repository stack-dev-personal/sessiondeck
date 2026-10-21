// Linux autostart: a systemd user unit in ~/.config/systemd/user/. No root. When `systemctl --user`
// has no bus (containers, ssh without a session) the unit is still written and the user is told how
// to start the daemon; that is not an error.
import { posix } from "node:path";
import { type AutostartDeps, type DaemonCommand, assertPlain } from "./types.ts";

export const UNIT_NAME = "sessiondeck-probe.service";

export function unitDir(home: string): string {
  return posix.join(home, ".config", "systemd", "user");
}

export function unitPath(home: string): string {
  return posix.join(unitDir(home), UNIT_NAME);
}

/**
 * One ExecStart word, double-quoted with systemd's C-style escapes. `%` (specifier) and `$`
 * (environment expansion) are doubled so a path can never be expanded.
 */
export function execWord(w: string): string {
  assertPlain("ExecStart word", w);
  const body = w
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%")
    .replace(/\$/g, "$$$$");
  return `"${body}"`;
}

export function unitFile(cmd: DaemonCommand): string {
  for (const p of [cmd.node, cmd.script, cmd.probeHome]) {
    if (!posix.isAbsolute(p)) throw new Error(`not an absolute path: ${p}`);
  }
  const exec = [cmd.node, cmd.script, "--home", cmd.probeHome].map(execWord).join(" ");
  return [
    "[Unit]",
    "Description=sessiondeck probe daemon",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${exec}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

const systemctl = (...args: string[]): string[] => ["--user", ...args];
export const SYSTEMCTL = "systemctl";

async function hasUserBus(d: AutostartDeps): Promise<boolean> {
  const r = await d.exec(SYSTEMCTL, systemctl("show-environment"));
  return r.code === 0;
}

export async function installSystemd(d: AutostartDeps, cmd: DaemonCommand): Promise<number> {
  const file = unitPath(d.e.home);
  const text = unitFile(cmd);
  const before = await d.fs.read(file);
  await d.fs.mkdirp(unitDir(d.e.home));
  if (before !== text) await d.fs.write(file, text);
  d.out(`${before === text ? "unit already up to date" : "wrote the unit"}: ${file}`);
  if (!(await hasUserBus(d))) {
    d.out(
      "note: `systemctl --user` is not available here (no user bus: a container, or no login session), so the unit is written but not enabled.",
    );
    d.out(
      `To start the daemon on a machine with a user session: systemctl --user daemon-reload && systemctl --user enable --now ${UNIT_NAME}`,
    );
    d.out("Or run it in the foreground: probe daemon run");
    return 0;
  }
  const steps: string[][] = [["daemon-reload"], ["enable", "--now", UNIT_NAME]];
  if (before !== undefined && before !== text) steps.push(["restart", UNIT_NAME]);
  for (const s of steps) {
    const r = await d.exec(SYSTEMCTL, systemctl(...s));
    if (r.code !== 0) {
      d.err(
        `probe: systemctl --user ${s.join(" ")} failed: ${(r.spawnError ?? (r.stderr.trim() || `exit ${String(r.code)}`)).slice(0, 400)}`,
      );
      return 1;
    }
  }
  d.out(`enabled and started ${UNIT_NAME}`);
  d.out(`check it with: systemctl --user status ${UNIT_NAME}`);
  return 0;
}

export async function uninstallSystemd(d: AutostartDeps): Promise<number> {
  const file = unitPath(d.e.home);
  const exists = (await d.fs.read(file)) !== undefined;
  if (await hasUserBus(d)) {
    if (exists) {
      const r = await d.exec(SYSTEMCTL, systemctl("disable", "--now", UNIT_NAME));
      if (r.code !== 0) {
        d.err(
          `probe: systemctl --user disable --now failed: ${(r.stderr.trim() || `exit ${String(r.code)}`).slice(0, 400)}`,
        );
        return 1;
      }
    }
    await d.fs.remove(file);
    if (exists) await d.exec(SYSTEMCTL, systemctl("daemon-reload"));
  } else {
    await d.fs.remove(file);
    if (exists)
      d.out(
        "note: no user bus; if the unit was running, stop the node process that runs daemon.mjs",
      );
  }
  d.out(exists ? `removed ${file}` : `${UNIT_NAME} is not installed; nothing to remove`);
  return 0;
}
