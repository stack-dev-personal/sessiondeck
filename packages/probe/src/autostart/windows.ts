// Windows autostart (D-S2-7): a per-user Task Scheduler logon task. Trigger AtLogOn for the current
// user (DOMAIN\user), RunLevel LeastPrivilege ("Limited"), Interactive logon (no stored password, no
// admin), restart on failure, no execution time limit. The console is hidden by a launcher file
// inside the probe home (<LOCALAPPDATA>\sessiondeck): wscript.exe runs it, it runs node with window
// style 0 and waits, so the task stays "running" while the daemon lives. Task Scheduler only restarts
// a task that fails to start, not one whose action later exits non-zero, so the launcher itself
// restarts the daemon after a non-zero exit (backoff 5 s doubling to 60 s). Exit 0 (graceful stop, or
// another daemon already holds the lock for this home) ends the launcher: no tight loop. The daemon
// only ever writes under the probe home; the task definition itself lives in the Task Scheduler store.
//
// All commands are exec form (schtasks.exe with an argv, the task defined by an XML file), so no
// path is ever interpolated into a shell string.
import { win32 } from "node:path";
import { stopDaemonWindows } from "./stop-daemon.ts";
import { schtasksPath, wscriptPath } from "./windows-paths.ts";
import {
  type AutostartDeps,
  type AutostartEnv,
  type DaemonCommand,
  type ExecResult,
  assertPlain,
} from "./types.ts";

export { schtasksPath, wscriptPath };

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

export interface LauncherOptions {
  /** First restart delay in ms (default 5000; doubles up to 60000). Tests shorten it. */
  initialDelayMs?: number;
}

/** A path word is refused when it could be altered on its way through wscript or the scheduler. */
function assertLaunchable(label: string, v: string): void {
  assertPlain(label, v);
  if (v.includes('"')) throw new Error(`${label} contains a double quote`);
  // WshShell.Run and Task Scheduler expand %VAR% in command strings.
  if (v.includes("%")) throw new Error(`${label} contains a percent sign`);
}

/**
 * VBScript that starts the daemon with a hidden window and waits for it. A non-zero exit restarts it
 * after a backoff (5 s, doubling, capped at 60 s; reset after a run of 10 minutes or more); exit 0
 * ends the launcher, including the "another daemon holds the lock" exit.
 */
export function launcherScript(cmd: DaemonCommand, opts: LauncherOptions = {}): string {
  for (const [label, v] of [
    ["node path", cmd.node],
    ["daemon script", cmd.script],
    ["probe home", cmd.probeHome],
  ] as const) {
    assertLaunchable(label, v);
  }
  const first = Math.max(1, Math.floor(opts.initialDelayMs ?? 5000));
  // cmd.exe is not involved: wscript passes this line to CreateProcess.
  const line = `"${cmd.node}" "${cmd.script}" --home "${cmd.probeHome}"`;
  return [
    "' sessiondeck probe daemon launcher (written by `probe daemon install`; safe to delete via `probe daemon uninstall`)",
    'Set sh = CreateObject("WScript.Shell")',
    `first = ${String(first)}`,
    "delay = first",
    "Do",
    "  started = Timer",
    "  On Error Resume Next",
    `  rc = sh.Run(${vbs(line)}, 0, True)`,
    "  If Err.Number <> 0 Then",
    "    rc = 1",
    "    Err.Clear",
    "  End If",
    "  On Error GoTo 0",
    "  If rc = 0 Then WScript.Quit 0",
    "  ran = Timer - started",
    "  If ran < 0 Then ran = ran + 86400", // Timer wraps at midnight
    "  If ran >= 600 Then delay = first",
    "  WScript.Sleep delay",
    "  delay = delay * 2",
    "  If delay > 60000 Then delay = 60000",
    "Loop",
    "",
  ].join("\r\n");
}

/** The task definition. Rendered with CRLF; written as UTF-16LE with a BOM. */
export function taskXml(e: AutostartEnv, probeHome: string): string {
  assertLaunchable("probe home", probeHome);
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
/** Lists every task as CSV: locale-independent, unlike the text of an error message. */
export const listArgs = (): string[] => ["/Query", "/FO", "CSV", "/NH"];
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

/** Both markers must be present in the registered task for it to count as ours. */
export function isOurTask(xml: string): boolean {
  const t = xml.split("\0").join("");
  return t.includes("sessiondeck probe daemon") && t.includes("launch-daemon.vbs");
}

type TaskState = "absent" | "ours" | "foreign" | "error";

/** Is a root-folder task of this name registered, and is it ours? Prints the reason on error. */
async function taskState(d: AutostartDeps, name: string): Promise<TaskState> {
  const l = await d.exec(schtasksPath(d.e), listArgs());
  if (l.code !== 0) {
    d.err(
      `probe: could not list scheduled tasks: ${detail(l)}${l.spawnError ? " (is Windows installed in C:\\Windows?)" : ""}`,
    );
    return "error";
  }
  const want = `"\\${name}"`.toLowerCase();
  const present = l.stdout
    .split("\0")
    .join("")
    .split(/\r?\n/)
    .some((ln) => ln.trim().toLowerCase().startsWith(want));
  if (!present) return "absent";
  const q = await d.exec(schtasksPath(d.e), queryXmlArgs(name));
  if (q.code !== 0) {
    d.err(`probe: could not read the scheduled task ${name}: ${detail(q)}`);
    return "error";
  }
  if (!isOurTask(q.stdout)) {
    d.err(
      `probe: a scheduled task named ${name} exists and is not a sessiondeck probe task; not touching it (pick another --task-name)`,
    );
    return "foreign";
  }
  return "ours";
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
  const state = await taskState(d, name);
  if (state === "error" || state === "foreign") return 1;
  if (state === "ours") {
    // Stop the running instance first: /Create /F replaces the definition but not the process, and
    // /Run is a no-op while it runs. /End kills the launcher but not necessarily the node.exe it
    // started, so the daemon itself is stopped too. The new launcher is written only after both.
    await d.exec(schtasksPath(d.e), endArgs(name));
    if (!(await stopDaemonWindows(d, cmd.probeHome))) return 1;
  }
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

/** Removes the task and the files install wrote. Absent is success; a task that is not ours is not touched. */
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
  const state = await taskState(d, name);
  if (state === "error" || state === "foreign") return 1;
  if (state === "ours") {
    await d.exec(schtasksPath(d.e), endArgs(name)); // best effort: stops the launcher if running
    // Then the daemon it started; a failure is reported but must not keep the task registered.
    await stopDaemonWindows(d, probeHome);
    const r = await d.exec(schtasksPath(d.e), deleteArgs(name));
    if (r.code !== 0) {
      d.err(`probe: could not remove the scheduled task ${name}: ${detail(r)}`);
      return 1;
    }
    d.out(`removed the scheduled task ${name}`);
  } else {
    d.out(`the scheduled task ${name} is not registered; nothing to remove`);
  }
  await d.fs.remove(launcherPath(probeHome));
  await d.fs.remove(taskXmlPath(probeHome));
  return 0;
}
