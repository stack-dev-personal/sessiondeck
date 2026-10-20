// `probe daemon install|uninstall` (D-S2-7): argv, XML, launcher and unit-file generation, and
// idempotence, on both platforms. Nothing touches the host: OS calls go through a fake exec and
// files through an in-memory fs (Windows runs are simulated on any host).
import { describe, expect, it } from "vitest";
import {
  type AutostartEnv,
  type AutostartFs,
  type ExecFn,
  type ExecResult,
} from "../src/autostart/types.ts";
import { runAutostart } from "../src/autostart/index.ts";
import {
  DEFAULT_TASK_NAME,
  createArgs,
  currentUserId,
  launcherScript,
  taskXml,
  validTaskName,
  xmlEscape,
} from "../src/autostart/windows.ts";
import { UNIT_NAME, execWord, unitFile, unitPath } from "../src/autostart/systemd.ts";

interface Call {
  file: string;
  args: string[];
}

function memFs(): AutostartFs & { files: Map<string, string | Uint8Array>; dirs: Set<string> } {
  const files = new Map<string, string | Uint8Array>();
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    mkdirp: async (d) => void dirs.add(d),
    write: async (f, data) => void files.set(f, data),
    read: async (f) => {
      const v = files.get(f);
      return v === undefined ? undefined : typeof v === "string" ? v : Buffer.from(v).toString();
    },
    remove: async (f) => void files.delete(f),
  };
}

const ok: ExecResult = { code: 0, stdout: "", stderr: "" };
const fail = (stderr = "boom"): ExecResult => ({ code: 1, stdout: "", stderr });

const winEnv: AutostartEnv = {
  platform: "win32",
  env: { USERDOMAIN: "LAPTOP", USERNAME: "Ada Lovelace", SystemRoot: "C:\\Windows" },
  home: "C:\\Users\\Ada Lovelace",
  userName: "Ada Lovelace",
};
const linuxEnv: AutostartEnv = {
  platform: "linux",
  env: {},
  home: "/home/ada",
  userName: "ada",
};

function harness(e: AutostartEnv, respond: (c: Call, tasks: Set<string>) => ExecResult) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const fs = memFs();
  const tasks = new Set<string>();
  const exec: ExecFn = async (file, args) => {
    const c = { file, args };
    calls.push(c);
    return respond(c, tasks);
  };
  const run = (argv: string[], distDir: string, nodePath: string) =>
    runAutostart(argv, {
      e,
      distDir,
      nodePath,
      exec,
      fs,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
  return { calls, out, err, fs, tasks, run };
}

/** A tiny schtasks: /Create adds, /Delete removes, /Query succeeds if present. */
const fakeSchtasks = (c: Call, tasks: Set<string>): ExecResult => {
  const verb = c.args[0];
  const name = c.args[2] as string;
  if (verb === "/Create") {
    tasks.add(name);
    return ok;
  }
  if (verb === "/Delete") return tasks.delete(name) ? ok : fail("not found");
  if (verb === "/Query")
    return tasks.has(name) ? ok : fail("ERROR: The system cannot find the file");
  return ok;
};

const NODE_W = "C:\\Program Files\\nodejs\\node.exe";
const DIST_W = "C:\\Users\\Ada Lovelace\\sd\\packages\\probe\\dist";
const HOME_W = "C:\\Users\\Ada Lovelace\\AppData\\Local\\sessiondeck";

describe("windows task", () => {
  it("builds a per-user, non-elevated, interactive logon task with restart and no time limit", () => {
    const xml = taskXml(winEnv, HOME_W);
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<UserId>LAPTOP\\Ada Lovelace</UserId>");
    expect(xml.match(/<UserId>LAPTOP\\Ada Lovelace<\/UserId>/g)).toHaveLength(2); // trigger + principal
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).not.toContain("HighestAvailable");
    expect(xml).not.toContain("<Password>");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<RestartOnFailure>");
    expect(xml).toContain("<Count>999</Count>");
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    // wscript runs the launcher in the probe home; the path with spaces is quoted in Arguments
    expect(xml).toContain("<Command>C:\\Windows\\System32\\wscript.exe</Command>");
    expect(xml).toContain(
      `<Arguments>//B //Nologo &quot;${HOME_W}\\launch-daemon.vbs&quot;</Arguments>`,
    );
  });

  it("escapes XML in user and paths", () => {
    expect(xmlEscape(`a&b<c>"d'`)).toBe("a&amp;b&lt;c&gt;&quot;d&apos;");
    const e = { ...winEnv, env: { ...winEnv.env, USERNAME: "a&b" } };
    expect(taskXml(e, HOME_W)).toContain("LAPTOP\\a&amp;b");
  });

  it("falls back to the account name without a domain, and to C:\\Windows", () => {
    const e: AutostartEnv = { ...winEnv, env: {} };
    expect(currentUserId(e)).toBe("Ada Lovelace");
    expect(taskXml(e, HOME_W)).toContain("C:\\Windows\\System32\\wscript.exe");
    // a relative SystemRoot from the environment is not trusted
    const rel: AutostartEnv = { ...winEnv, env: { SystemRoot: "evil" } };
    expect(taskXml(rel, HOME_W)).toContain("C:\\Windows\\System32\\wscript.exe");
  });

  it("launcher runs node hidden (window style 0), waits, and passes the exit code on", () => {
    const s = launcherScript({
      node: NODE_W,
      script: `${DIST_W}\\daemon.mjs`,
      probeHome: HOME_W,
    });
    expect(s).toContain('Set sh = CreateObject("WScript.Shell")');
    expect(s).toContain(
      `rc = sh.Run("""${NODE_W}"" ""${DIST_W}\\daemon.mjs"" --home ""${HOME_W}""", 0, True)`,
    );
    expect(s).toContain("WScript.Quit rc");
  });

  it("refuses paths with a double quote or control character", () => {
    const base = { node: NODE_W, script: `${DIST_W}\\daemon.mjs`, probeHome: HOME_W };
    expect(() => launcherScript({ ...base, probeHome: 'C:\\a"b' })).toThrow(/double quote/);
    expect(() => launcherScript({ ...base, node: "C:\\a\nb" })).toThrow(/control/);
  });

  it("validates task names", () => {
    expect(validTaskName(DEFAULT_TASK_NAME)).toBe(true);
    expect(validTaskName("sd test-1.x")).toBe(true);
    for (const bad of ["", "\\evil\\x", "a/b", '"; calc', "-x"])
      expect(validTaskName(bad)).toBe(false);
  });

  it("install: writes launcher and xml under the probe home, then schtasks /Create /F with an XML file, then /Run", async () => {
    const h = harness(winEnv, fakeSchtasks);
    expect(await h.run(["install"], DIST_W, NODE_W)).toBe(0);
    const xmlFile = `${HOME_W}\\daemon-task.xml`;
    expect(h.calls.map((c) => [c.file, ...c.args])).toEqual([
      ["C:\\Windows\\System32\\schtasks.exe", ...createArgs(DEFAULT_TASK_NAME, xmlFile)],
      ["C:\\Windows\\System32\\schtasks.exe", "/Run", "/TN", DEFAULT_TASK_NAME],
    ]);
    expect(createArgs("T", "x.xml")).toEqual(["/Create", "/TN", "T", "/XML", "x.xml", "/F"]);
    // every file written stays under the probe home; the xml is removed after registering
    for (const f of h.fs.files.keys()) expect(f.startsWith(`${HOME_W}\\`)).toBe(true);
    expect([...h.fs.files.keys()]).toEqual([`${HOME_W}\\launch-daemon.vbs`]);
    const vbs = h.fs.files.get(`${HOME_W}\\launch-daemon.vbs`) as Uint8Array;
    expect([vbs[0], vbs[1]]).toEqual([0xff, 0xfe]); // UTF-16LE BOM
    expect(Buffer.from(vbs).subarray(2).toString("utf16le")).toContain("daemon.mjs");
    expect(h.tasks.size).toBe(1);
  });

  it("the XML handed to schtasks is UTF-16LE with a BOM", async () => {
    let seen: Uint8Array | undefined;
    const h = harness(winEnv, fakeSchtasks);
    const realWrite = h.fs.write;
    h.fs.write = async (f, d) => {
      if (f.endsWith(".xml")) seen = d as Uint8Array;
      await realWrite(f, d);
    };
    await h.run(["install", "--no-start"], DIST_W, NODE_W);
    expect(seen && [seen[0], seen[1]]).toEqual([0xff, 0xfe]);
    expect(
      Buffer.from(seen as Uint8Array)
        .subarray(2)
        .toString("utf16le"),
    ).toContain("<LogonTrigger>");
    expect(h.calls).toHaveLength(1); // --no-start: no /Run
  });

  it("install twice leaves one task; uninstall removes it; uninstall again succeeds quietly", async () => {
    const h = harness(winEnv, fakeSchtasks);
    expect(await h.run(["install"], DIST_W, NODE_W)).toBe(0);
    expect(await h.run(["install"], DIST_W, NODE_W)).toBe(0);
    expect(h.tasks.size).toBe(1);
    expect(await h.run(["uninstall"], DIST_W, NODE_W)).toBe(0);
    expect(h.tasks.size).toBe(0);
    expect(h.fs.files.size).toBe(0);
    h.err.length = 0;
    expect(await h.run(["uninstall"], DIST_W, NODE_W)).toBe(0);
    expect(h.err).toEqual([]);
    expect(h.out.at(-1)).toContain("not registered");
  });

  it("uninstall order: query, end, delete /F", async () => {
    const h = harness(winEnv, fakeSchtasks);
    await h.run(["install", "--no-start"], DIST_W, NODE_W);
    h.calls.length = 0;
    await h.run(["uninstall"], DIST_W, NODE_W);
    expect(h.calls.map((c) => c.args)).toEqual([
      ["/Query", "/TN", DEFAULT_TASK_NAME],
      ["/End", "/TN", DEFAULT_TASK_NAME],
      ["/Delete", "/TN", DEFAULT_TASK_NAME, "/F"],
    ]);
  });

  it("a failed registration is reported and exits non-zero", async () => {
    const h = harness(winEnv, () => fail("ERROR: Access is denied."));
    expect(await h.run(["install"], DIST_W, NODE_W)).toBe(1);
    expect(h.err.join("\n")).toContain("Access is denied");
    expect(h.fs.files.has(`${HOME_W}\\daemon-task.xml`)).toBe(false);
  });

  it("a task that registered but would not start now is a note, not a failure", async () => {
    const h = harness(winEnv, (c) => (c.args[0] === "/Run" ? fail("busy") : ok));
    expect(await h.run(["install"], DIST_W, NODE_W)).toBe(0);
    expect(h.out.join("\n")).toContain("did not start now");
  });

  it("--home and --task-name are honoured", async () => {
    const h = harness(winEnv, fakeSchtasks);
    await h.run(
      ["install", "--no-start", "--home", "D:\\sd", "--task-name", "sd test 1"],
      DIST_W,
      NODE_W,
    );
    expect(h.calls[0]?.args.slice(0, 3)).toEqual(["/Create", "/TN", "sd test 1"]);
    expect(h.calls[0]?.args[4]).toBe("D:\\sd\\daemon-task.xml");
    expect(await h.run(["install", "--task-name", "a/b"], DIST_W, NODE_W)).toBe(2);
  });
});

describe("systemd user unit", () => {
  const cmd = {
    node: "/usr/bin/node",
    script: "/opt/sd/dist/daemon.mjs",
    probeHome: "/home/ada/.local/state/sessiondeck",
  };

  it("renders Restart=on-failure and an absolute, quoted ExecStart", () => {
    const u = unitFile(cmd);
    expect(u).toContain("Restart=on-failure");
    expect(u).toContain("WantedBy=default.target");
    expect(u).toContain(
      'ExecStart="/usr/bin/node" "/opt/sd/dist/daemon.mjs" "--home" "/home/ada/.local/state/sessiondeck"',
    );
  });

  it("escapes backslash, quote, percent and dollar; refuses relative paths and newlines", () => {
    expect(execWord('a b\\c"d%e$f')).toBe('"a b\\\\c\\"d%%e$$f"');
    expect(() => unitFile({ ...cmd, node: "node" })).toThrow(/absolute/);
    expect(() => execWord("a\nb")).toThrow(/control/);
  });

  const withBus = (): ExecResult => ok;

  it("install with a user bus: writes the unit, daemon-reload, enable --now", async () => {
    const h = harness(linuxEnv, withBus);
    expect(await h.run(["install"], "/opt/sd/dist", "/usr/bin/node")).toBe(0);
    const file = unitPath("/home/ada");
    expect(file).toBe(`/home/ada/.config/systemd/user/${UNIT_NAME}`);
    expect(h.fs.files.get(file)).toBe(
      unitFile({
        node: "/usr/bin/node",
        script: "/opt/sd/dist/daemon.mjs",
        probeHome: "/home/ada/.local/state/sessiondeck",
      }),
    );
    expect(h.calls.map((c) => [c.file, ...c.args])).toEqual([
      ["systemctl", "--user", "show-environment"],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", UNIT_NAME],
    ]);
  });

  it("install again with the same unit changes nothing; a changed unit also restarts", async () => {
    const h = harness(linuxEnv, withBus);
    await h.run(["install"], "/opt/sd/dist", "/usr/bin/node");
    h.calls.length = 0;
    await h.run(["install"], "/opt/sd/dist", "/usr/bin/node");
    expect(h.out.some((l) => l.includes("already up to date"))).toBe(true);
    expect(h.calls.some((c) => c.args[0] === "--user" && c.args[1] === "restart")).toBe(false);
    h.calls.length = 0;
    await h.run(["install"], "/elsewhere/dist", "/usr/bin/node");
    expect(h.calls.at(-1)?.args).toEqual(["--user", "restart", UNIT_NAME]);
  });

  it("no user bus: unit is written, how-to-start is printed, exit 0, no enable attempted", async () => {
    const h = harness(linuxEnv, () => fail("Failed to connect to bus: No medium found"));
    expect(await h.run(["install"], "/opt/sd/dist", "/usr/bin/node")).toBe(0);
    expect(h.fs.files.has(unitPath("/home/ada"))).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(h.out.join("\n")).toContain(
      "systemctl --user daemon-reload && systemctl --user enable --now",
    );
    expect(h.out.join("\n")).toContain("probe daemon run");
  });

  it("systemctl missing entirely behaves like no bus", async () => {
    const h = harness(linuxEnv, () => ({
      code: null,
      stdout: "",
      stderr: "",
      spawnError: "spawn systemctl ENOENT",
    }));
    expect(await h.run(["install"], "/opt/sd/dist", "/usr/bin/node")).toBe(0);
    expect(h.fs.files.has(unitPath("/home/ada"))).toBe(true);
  });

  it("a failing enable is an error", async () => {
    const h = harness(linuxEnv, (c) => (c.args[1] === "enable" ? fail("denied") : ok));
    expect(await h.run(["install"], "/opt/sd/dist", "/usr/bin/node")).toBe(1);
    expect(h.err.join("\n")).toContain("denied");
  });

  it("uninstall: disable --now, remove the file, daemon-reload; again is a quiet success", async () => {
    const h = harness(linuxEnv, withBus);
    await h.run(["install"], "/opt/sd/dist", "/usr/bin/node");
    h.calls.length = 0;
    expect(await h.run(["uninstall"], "/opt/sd/dist", "/usr/bin/node")).toBe(0);
    expect(h.calls.map((c) => c.args.slice(1))).toEqual([
      ["show-environment"],
      ["disable", "--now", UNIT_NAME],
      ["daemon-reload"],
    ]);
    expect(h.fs.files.size).toBe(0);
    h.calls.length = 0;
    expect(await h.run(["uninstall"], "/opt/sd/dist", "/usr/bin/node")).toBe(0);
    expect(h.calls.map((c) => c.args.slice(1))).toEqual([["show-environment"]]);
    expect(h.out.at(-1)).toContain("not installed");
  });

  it("uninstall without a bus still removes the file", async () => {
    const h = harness(linuxEnv, () => fail());
    h.fs.files.set(unitPath("/home/ada"), "x");
    expect(await h.run(["uninstall"], "/opt/sd/dist", "/usr/bin/node")).toBe(0);
    expect(h.fs.files.size).toBe(0);
  });
});

describe("other platforms and usage", () => {
  it("macOS is not supported yet: non-zero, nothing executed", async () => {
    const h = harness({ ...linuxEnv, platform: "darwin" }, () => ok);
    expect(await h.run(["install"], "/d", "/n")).toBe(1);
    expect(h.err.join("\n")).toContain("not supported yet on macOS");
    expect(h.calls).toHaveLength(0);
  });

  it("unknown verbs and options are usage errors", async () => {
    const h = harness(linuxEnv, () => ok);
    expect(await h.run(["bogus"], "/d", "/n")).toBe(2);
    expect(await h.run(["install", "--nope"], "/d", "/n")).toBe(2);
    expect(await h.run(["install", "--home"], "/d", "/n")).toBe(2);
    expect(h.calls).toHaveLength(0);
  });
});
