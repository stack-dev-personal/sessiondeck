// Windows autostart (D-S2-7): a per-user Task Scheduler logon task. Trigger AtLogOn for the current
// user (DOMAIN\user), RunLevel LeastPrivilege ("Limited"), Interactive logon (no stored password, no
// admin), restart on failure, no execution time limit. The console is hidden by a launcher file
// inside the probe home (<LOCALAPPDATA>\sessiondeck): wscript.exe runs it, it runs node with window
// style 0 and waits, so the task stays "running" while the daemon lives and a non-zero exit is a
// failure the scheduler restarts. The daemon only ever writes under the probe home; the task
// definition itself lives in the Task Scheduler store.
//
// All commands are exec form (schtasks.exe with an argv, the task defined by an XML file), so no
// path is ever interpolated into a shell string.
import { win32 } from "node:path";
import {
  type AutostartDeps,
  type AutostartEnv,
  type DaemonCommand,
  type ExecResult,
  assertPlain,
} from "./types.ts";

export const DEFAULT_TASK_NAME = "SessionDeckProbeDaemon";

/** Task names are a single path segment of plain characters. */
export function validTaskName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,100}$/.test(name);
}

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** DOMAIN\user for the current account. */
export function currentUserId(e: AutostartEnv): string {
  const name = e.env["USERNAME"] || e.userName;
  const domain = e.env["USERDOMAIN"];
  return domain ? `${domain}\\${name}` : name;
}

function system32(e: AutostartEnv, exe: string): string {
  const root = e.env["SystemRoot"] ?? e.env["SYSTEMROOT"] ?? e.env["windir"];
  const base = root && win32.isAbsolute(root) ? root : "C:\\Windows";
  return win32.join(base, "System32", exe);
}

export const schtasksPath = (e: AutostartEnv): string => system32(e, "schtasks.exe");
export const wscriptPath = (e: AutostartEnv): string => system32(e, "wscript.exe");

export function launcherPath(probeHome: string): string {
  return win32.join(probeHome, "launch-daemon.vbs");
}

export function taskXmlPath(probeHome: string): string {
  return win32.join(probeHome, "daemon-task.xml");
}

/** A VBScript string literal: quotes doubled. */
function vbs(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * VBScript that starts the daemon with a hidden window and waits for it. WScript.Quit passes the
 * daemon's exit code to the scheduler.
 */
export function launcherScript(cmd: DaemonCommand): string {
  for (const [label, v] of [
    ["node path", cmd.node],
    ["daemon script", cmd.script],
    ["probe home", cmd.probeHome],
  ] as const) {
    assertPlain(label, v);
    if (v.includes('"')) throw new Error(`${label} contains a double quote`);
  }
  // cmd.exe is not involved: wscript passes this line to CreateProcess.
  const line = `"${cmd.node}" "${cmd.script}" --home "${cmd.probeHome}"`;
  return [
    "' sessiondeck probe daemon launcher (written by `probe daemon install`; safe to delete via `probe daemon uninstall`)",
    'Set sh = CreateObject("WScript.Shell")',
    `rc = sh.Run(${vbs(line)}, 0, True)`,
    "WScript.Quit rc",
    "",
  ].join("\r\n");
}

/** The task definition. Rendered with CRLF; written as UTF-16LE with a BOM. */
export function taskXml(e: AutostartEnv, probeHome: string): string {
  const user = xmlEscape(currentUserId(e));
  const wscript = xmlEscape(wscriptPath(e));
  const args = xmlEscape(`//B //Nologo "${launcherPath(probeHome)}"`);
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    "    <Description>sessiondeck probe daemon: forwards Claude Code session events to your hub. Remove with: probe daemon uninstall</Description>",
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <LogonTrigger>",
    "      <Enabled>true</Enabled>",
    `      <UserId>${user}</UserId>`,
    "    </LogonTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    `      <UserId>${user}</UserId>`,
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>false</Hidden>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <RestartOnFailure>",
    "      <Interval>PT1M</Interval>",
    "      <Count>999</Count>",
    "    </RestartOnFailure>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      <Command>${wscript}</Command>`,
    `      <Arguments>${args}</Arguments>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

/** UTF-16LE with a byte order mark, which schtasks /XML accepts for every character. */
export function utf16leBom(s: string): Uint8Array {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
}

export const createArgs = (name: string, xmlFile: string): string[] => [
  "/Create",
  "/TN",
  name,
  "/XML",
  xmlFile,
  "/F",
];
export const queryArgs = (name: string): string[] => ["/Query", "/TN", name];
export const queryXmlArgs = (name: string): string[] => ["/Query", "/TN", name, "/XML"];
export const runArgs = (name: string): string[] => ["/Run", "/TN", name];
export const endArgs = (name: string): string[] => ["/End", "/TN", name];
export const deleteArgs = (name: string): string[] => ["/Delete", "/TN", name, "/F"];

function detail(r: ExecResult): string {
  return (r.spawnError ?? (r.stderr.trim() || r.stdout.trim() || `exit ${String(r.code)}`)).slice(
    0,
    400,
  );
}

export interface WinOptions {
  taskName?: string;
  /** Start the task right after registering it (default true). */
  start?: boolean;
}

/** Registers (or re-registers: /F replaces) the logon task. Returns the exit code. */
export async function installWindows(
  d: AutostartDeps,
  cmd: DaemonCommand,
  opts: WinOptions = {},
): Promise<number> {
  const name = opts.taskName ?? DEFAULT_TASK_NAME;
  if (!validTaskName(name)) {
    d.err(`probe: invalid task name ${JSON.stringify(name)}`);
    return 2;
  }
  const xmlFile = taskXmlPath(cmd.probeHome);
  const xml = taskXml(d.e, cmd.probeHome);
  const script = launcherScript(cmd);
  await d.fs.mkdirp(cmd.probeHome);
  await d.fs.write(launcherPath(cmd.probeHome), utf16leBom(script));
  await d.fs.write(xmlFile, utf16leBom(xml));
  let r: ExecResult;
  try {
    r = await d.exec(schtasksPath(d.e), createArgs(name, xmlFile));
  } finally {
    await d.fs.remove(xmlFile);
  }
  if (r.code !== 0) {
    d.err(`probe: could not register the scheduled task ${name}: ${detail(r)}`);
    return 1;
  }
  d.out(
    `registered the scheduled task ${name} (runs at logon as ${currentUserId(d.e)}, not elevated)`,
  );
  d.out(`launcher: ${launcherPath(cmd.probeHome)}`);
  if (opts.start !== false) {
    const s = await d.exec(schtasksPath(d.e), runArgs(name));
    if (s.code === 0) d.out("started the daemon now");
    else
      d.out(
        `note: the task is registered but did not start now (${detail(s)}); it starts at your next logon, or run: schtasks /Run /TN ${name}`,
      );
  }
  d.out(`check it with: schtasks /Query /TN ${name} /V /FO LIST`);
  return 0;
}

/** Removes the task and the files install wrote. Absent is success. */
export async function uninstallWindows(
  d: AutostartDeps,
  probeHome: string,
  opts: WinOptions = {},
): Promise<number> {
  const name = opts.taskName ?? DEFAULT_TASK_NAME;
  if (!validTaskName(name)) {
    d.err(`probe: invalid task name ${JSON.stringify(name)}`);
    return 2;
  }
  const q = await d.exec(schtasksPath(d.e), queryArgs(name));
  if (q.code === 0) {
    await d.exec(schtasksPath(d.e), endArgs(name)); // best effort: stops the launcher if running
    const r = await d.exec(schtasksPath(d.e), deleteArgs(name));
    if (r.code !== 0) {
      d.err(`probe: could not remove the scheduled task ${name}: ${detail(r)}`);
      return 1;
    }
    d.out(`removed the scheduled task ${name}`);
    d.out(
      "note: a daemon that is already running keeps running until you log off or stop it (Task Manager: node.exe)",
    );
  } else if (q.spawnError) {
    d.err(`probe: could not run schtasks: ${detail(q)}`);
    return 1;
  } else {
    d.out(`the scheduled task ${name} is not registered; nothing to remove`);
  }
  await d.fs.remove(launcherPath(probeHome));
  await d.fs.remove(taskXmlPath(probeHome));
  return 0;
}
