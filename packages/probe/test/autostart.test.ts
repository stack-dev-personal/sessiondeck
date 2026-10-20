// `probe daemon install|uninstall` (D-S2-7): argv, XML, launcher and unit-file generation, and
// idempotence, on both platforms. Nothing touches the host: OS calls go through a fake exec and
// files through an in-memory fs (Windows runs are simulated on any host).
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AutostartEnv,
  type AutostartFs,
  type ExecFn,
  type ExecResult,
  realFs,
} from "../src/autostart/types.ts";
import { runAutostart } from "../src/autostart/index.ts";
import {
  DEFAULT_TASK_NAME,
  createArgs,
  listArgs,
  currentUserId,
  launcherScript,
  schtasksPath,
  taskXml,
  wscriptPath,
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
    statPath: async () => undefined,
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

const OURS_XML =
  "<Task><RegistrationInfo><Description>sessiondeck probe daemon: forwards</Description></RegistrationInfo>" +
  "<Actions><Exec><Command>C:\\Windows\\System32\\wscript.exe</Command><Arguments>//B x\\launch-daemon.vbs</Arguments></Exec></Actions></Task>";
const FOREIGN_XML = "<Task><Actions><Exec><Command>calc.exe</Command></Exec></Actions></Task>";

/** A tiny schtasks: /Create adds, /Delete removes, listing and /XML reflect the store. */
const fakeSchtasks = (
  c: Call,
  tasks: Set<string>,
  foreign: Set<string> = new Set(),
): ExecResult => {
  const verb = c.args[0];
  if (verb === "/Query" && c.args[1] === "/FO")
    return {
      code: 0,
      stdout: [...tasks, ...foreign].map((n) => `"\\${n}","N/A","Ready"`).join("\r\n"),
      stderr: "",
    };
  const name = c.args[2] as string;
  if (verb === "/Query" && c.args[3] === "/XML")
    return { code: 0, stdout: foreign.has(name) ? FOREIGN_XML : OURS_XML, stderr: "" };
  if (verb === "/Create") {
    tasks.add(name);
    return ok;
  }
  if (verb === "/Delete") return tasks.delete(name) ? ok : fail("not found");
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

  it("falls back to the account name without a domain; System32 is fixed at C:\\Windows", () => {
    const e: AutostartEnv = { ...winEnv, env: {} };
    expect(currentUserId(e)).toBe("Ada Lovelace");
    expect(taskXml(e, HOME_W)).toContain("C:\\Windows\\System32\\wscript.exe");
    expect(schtasksPath(e)).toBe("C:\\Windows\\System32\\schtasks.exe");
    // the same Windows root in another spelling is fine
    for (const v of ["c:\\windows", "C:\\WINDOWS\\", "C:/Windows"]) {
      const ok2: AutostartEnv = { ...winEnv, env: { SystemRoot: v } };
      expect(wscriptPath(ok2)).toBe("C:\\Windows\\System32\\wscript.exe");
    }
  });

  it("refuses a SystemRoot, SYSTEMROOT or windir that points anywhere else", () => {
    for (const k of ["SystemRoot", "SYSTEMROOT", "windir"]) {
      for (const v of ["evil", "D:\\repo\\bin", "C:\\Windows\\..\\evil", "C:\\WindowsX"]) {
        const bad: AutostartEnv = { ...winEnv, env: { [k]: v } };
        expect(() => taskXml(bad, HOME_W)).toThrow(/refusing/);
        expect(() => schtasksPath(bad)).toThrow(new RegExp(k));
      }
    }
  });

  it("install with a hostile SystemRoot runs nothing and writes nothing", async () => {
    const h = harness({ ...winEnv, env: { SystemRoot: "D:\\evil" } }, fakeSchtasks);
    expect(await h.run(["install"], DIST_W, NODE_W)).toBe(1);
    expect(h.err.join("\n")).toContain("refusing");
    expect(h.calls).toHaveLength(0);
    expect(h.fs.files.size).toBe(0);
  });

  it("launcher runs node hidden, waits, and restarts it after a non-zero exit with a capped backoff", () => {
    const s = launcherScript({
      node: NODE_W,
      script: `${DIST_W}\\daemon.mjs`,
      probeHome: HOME_W,
    });
    expect(s).toContain('Set sh = CreateObject("WScript.Shell")');
    expect(s).toContain(
      `rc = sh.Run("""${NODE_W}"" ""${DIST_W}\\daemon.mjs"" --home ""${HOME_W}""", 0, True)`,
    );
    // exit 0 (graceful stop, or another daemon holds the lock) ends the launcher
    expect(s).toContain("If rc = 0 Then WScript.Quit 0");
    // otherwise sleep, double, cap at 60 s, loop; a spawn failure counts as a failed run
    expect(s).toContain("first = 5000");
    expect(s).toContain("WScript.Sleep delay");
    expect(s).toContain("delay = delay * 2");
    expect(s).toContain("If delay > 60000 Then delay = 60000");
    expect(s).toContain("If ran >= 600 Then delay = first");
    expect(s).toContain("Loop");
    expect(s).toContain("rc = 1");
    expect(s).not.toContain("WScript.Quit rc");
    expect(
      launcherScript({ node: NODE_W, script: "s", probeHome: "h" }, { initialDelayMs: 200 }),
    ).toContain("first = 200");
    expect(s.split("\r\n").length).toBeGreaterThan(10); // CRLF
  });

  it("refuses paths with a double quote, a percent sign or a control character", () => {
    const base = { node: NODE_W, script: `${DIST_W}\\daemon.mjs`, probeHome: HOME_W };
    expect(() => launcherScript({ ...base, probeHome: 'C:\\a"b' })).toThrow(/double quote/);
    expect(() => launcherScript({ ...base, node: "C:\\a\nb" })).toThrow(/control/);
    expect(() => launcherScript({ ...base, probeHome: "C:\\Users\\a%OS%b" })).toThrow(/percent/);
    expect(() => taskXml(winEnv, "C:\\Users\\a%OS%b")).toThrow(/percent/);
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
      ["C:\\Windows\\System32\\schtasks.exe", ...listArgs()],
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
    expect(h.calls.map((c) => c.args[0])).toEqual(["/Query", "/Create"]); // --no-start: no /Run
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
      listArgs(),
      ["/Query", "/TN", DEFAULT_TASK_NAME, "/XML"],
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

  it("--home beneath the default home and --task-name are honoured", async () => {
    const h = harness(winEnv, fakeSchtasks);
    await h.run(
      ["install", "--no-start", "--home", `${HOME_W}\\t1`, "--task-name", "sd test 1"],
      DIST_W,
      NODE_W,
    );
    const create = h.calls.find((c) => c.args[0] === "/Create");
    expect(create?.args.slice(0, 3)).toEqual(["/Create", "/TN", "sd test 1"]);
    expect(create?.args[4]).toBe(`${HOME_W}\\t1\\daemon-task.xml`);
    expect(await h.run(["install", "--task-name", "a/b"], DIST_W, NODE_W)).toBe(2);
  });

  it("refuses a --home outside the user's default probe home on Windows", async () => {
    for (const bad of [
      "D:\\sd",
      "C:\\sd",
      "C:\\Users\\Ada Lovelace\\AppData\\Local\\sessiondeckX",
      "C:\\Users\\Ada Lovelace\\AppData\\Local",
      `${HOME_W}\\..\\x`,
    ]) {
      const h = harness(winEnv, fakeSchtasks);
      expect(await h.run(["install", "--home", bad], DIST_W, NODE_W), bad).toBe(1);
      expect(h.err.join("\n")).toContain("outside");
      expect(h.calls).toHaveLength(0);
      expect(h.fs.files.size).toBe(0);
    }
    const h = harness(winEnv, fakeSchtasks);
    expect(
      await h.run(["install", "--no-start", "--home", HOME_W.toUpperCase()], DIST_W, NODE_W),
    ).toBe(0);
  });

  it("a state query that fails for another reason is an error: uninstall keeps the launcher", async () => {
    const h = harness(winEnv, (c) =>
      c.args[0] === "/Query" ? fail("ERROR: Access is denied.") : ok,
    );
    h.fs.files.set(`${HOME_W}\\launch-daemon.vbs`, "x");
    expect(await h.run(["uninstall"], DIST_W, NODE_W)).toBe(1);
    expect(h.err.join("\n")).toContain("Access is denied");
    expect(h.fs.files.has(`${HOME_W}\\launch-daemon.vbs`)).toBe(true);
    expect(h.calls.some((c) => c.args[0] === "/Delete")).toBe(false);
    // a localized "cannot find" text does not matter: absence is read from the listing
    const g = harness(winEnv, (c) =>
      c.args[0] === "/Query" ? { code: 0, stdout: "", stderr: "" } : ok,
    );
    expect(await g.run(["uninstall"], DIST_W, NODE_W)).toBe(0);
  });

  it("reinstall over a running task of ours ends it before writing the new launcher", async () => {
    const h = harness(winEnv, fakeSchtasks);
    await h.run(["install"], DIST_W, NODE_W);
    h.calls.length = 0;
    expect(await h.run(["install"], DIST_W, NODE_W)).toBe(0);
    expect(h.calls.map((c) => c.args[0])).toEqual(["/Query", "/Query", "/End", "/Create", "/Run"]);
  });

  it("will not overwrite or delete a task of that name that is not ours", async () => {
    const tasks = new Set<string>();
    const foreign = new Set(["Backup"]);
    const h = harness(winEnv, (c) => fakeSchtasks(c, tasks, foreign));
    expect(await h.run(["install", "--task-name", "Backup"], DIST_W, NODE_W)).toBe(1);
    expect(h.err.join("\n")).toContain("not a sessiondeck probe task");
    expect(await h.run(["uninstall", "--task-name", "Backup"], DIST_W, NODE_W)).toBe(1);
    expect(h.calls.some((c) => ["/Create", "/Delete", "/End"].includes(c.args[0] as string))).toBe(
      false,
    );
    expect(h.fs.files.size).toBe(0);
    expect(foreign.has("Backup")).toBe(true);
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

describe("probe home ownership (POSIX)", () => {
  const stat = (uid: number, mode: number) => async () => ({ uid, mode });
  const withStat = (st: AutostartFs["statPath"]) => {
    const h = harness({ ...linuxEnv, uid: 1000 }, () => ok);
    h.fs.statPath = st;
    return h;
  };
  it("accepts a home we own that others cannot write", async () => {
    const h = withStat(stat(1000, 0o40700));
    expect(await h.run(["install", "--home", "/srv/sd"], "/opt/sd/dist", "/usr/bin/node")).toBe(0);
  });
  it("refuses a home owned by someone else or writable by group or world", async () => {
    for (const st of [stat(0, 0o40700), stat(1000, 0o40775), stat(1000, 0o40707)]) {
      const h = withStat(st);
      expect(await h.run(["install", "--home", "/srv/sd"], "/opt/sd/dist", "/usr/bin/node")).toBe(
        1,
      );
      expect(h.err.join("\n")).toMatch(/not owned|writable/);
      expect(h.calls).toHaveLength(0);
      expect(h.fs.files.size).toBe(0);
    }
  });
});

describe("realFs.write", () => {
  const posix = process.platform === "win32" ? it.skip : it;
  it("writes the exact bytes with a private mode and leaves no temp file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sd-fs-"));
    try {
      const f = join(dir, "a.txt");
      writeFileSync(f, "old", { mode: 0o666 });
      await realFs.write(f, "new");
      expect(readFileSync(f, "utf8")).toBe("new");
      if (process.platform !== "win32") expect(statSync(f).mode & 0o777).toBe(0o600);
      await realFs.write(f, "newer", 0o644);
      if (process.platform !== "win32") expect(statSync(f).mode & 0o777).toBe(0o644);
      const { readdirSync } = await import("node:fs");
      expect(readdirSync(dir)).toEqual(["a.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  posix("replaces a symlink at the target instead of writing through it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sd-fs-"));
    try {
      const victim = join(dir, "victim.txt");
      writeFileSync(victim, "keep");
      const link = join(dir, "launch.vbs");
      symlinkSync(victim, link);
      await realFs.write(link, "payload");
      expect(readFileSync(victim, "utf8")).toBe("keep");
      expect(readFileSync(link, "utf8")).toBe("payload");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
