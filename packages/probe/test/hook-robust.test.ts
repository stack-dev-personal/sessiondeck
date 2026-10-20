import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_LINE_BYTES, parseSpoolLine } from "../src/spool.ts";
import { dayFileName } from "../src/paths.ts";
import { resolveHostName } from "../src/host.ts";
import { fixturePerEvent, hookPath, readSpoolLines, runHook } from "./helpers.ts";

const win32 = process.platform === "win32";
const STOP = JSON.stringify({ session_id: "s1", hook_event_name: "Stop" });

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "sd-robust-"));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const tmp = (): string => mkdtempSync(join(tmpdir(), "sd-robust-x-"));

describe("R1.2 hook never fails and never prints", () => {
  const bad: [string, Buffer | string | null][] = [
    ["empty stdin", ""],
    ["closed stdin", null],
    ["not json", "not json"],
    ["array", "[]"],
    ["empty object", "{}"],
    ["null", "null"],
    ["number", "42"],
    ["invalid utf-8 bytes", Buffer.from([0xff, 0xfe, 0x7b, 0x80, 0xc3, 0x28])],
    ["object missing session_id", '{"hook_event_name":"Stop"}'],
    [
      "1 MB json",
      JSON.stringify({ session_id: "s", hook_event_name: "Stop", big: "x".repeat(1 << 20) }),
    ],
  ];
  for (const [name, input] of bad) {
    it(`exit 0, empty stdout, empty stderr: ${name}`, async () => {
      const r = await runHook(input, { home });
      expect(r.code).toBe(0);
      expect(r.stdout.toString()).toBe("");
      expect(r.stderr.toString()).toBe("");
    });
  }

  for (const { event, file } of fixturePerEvent()) {
    it(`exit 0, empty stdout: fixture ${event}`, async () => {
      const r = await runHook(readFileSync(file), { home });
      expect(r.code).toBe(0);
      expect(r.stdout.toString()).toBe("");
      expect(r.stderr.toString()).toBe("");
    });
  }

  it("fixtures landed in the spool as valid SpoolLines, 1 MB payload as a marker", () => {
    const lines = readSpoolLines(join(home, "spool"));
    expect(lines.length).toBeGreaterThan(13);
    for (const l of lines) {
      expect(Buffer.byteLength(l)).toBeLessThanOrEqual(MAX_LINE_BYTES);
      const p = parseSpoolLine(l);
      expect(p.ok).toBe(true);
      expect("seq" in JSON.parse(l)).toBe(false);
    }
    const marker = lines.map((l) => JSON.parse(l)).find((e) => e.payload?.truncated === true);
    expect(marker.payload.original_bytes).toBeGreaterThan(1 << 20);
  });

  it("rejected inputs append nothing and are logged without payload content", () => {
    const log = readFileSync(join(home, "hook-errors.log"), "utf8");
    expect(log).toMatch(/empty-stdin/);
    expect(log).toMatch(/invalid-json/);
    expect(log).toMatch(/not-an-object/);
    expect(log).not.toMatch(/xxxx/);
  });

  it("--home pointing at a file: still exit 0, no stdout", async () => {
    const file = join(home, "iam-a-file");
    writeFileSync(file, "x");
    const r = await runHook(readFileSync(fixturePerEvent()[0]!.file), { home: file });
    expect(r.code).toBe(0);
    expect(r.stdout.toString()).toBe("");
    expect(r.stderr.toString()).toBe("");
    expect(existsSync(join(file, "spool"))).toBe(false);
  });

  it("never-closing stdin does not hang the hook", async () => {
    const t0 = Date.now();
    const { spawn } = await import("node:child_process");
    const code = await new Promise<number | null>((resolve) => {
      const c = spawn(process.execPath, [hookPath, "--home", home], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      c.on("close", resolve); // stdin deliberately left open
    });
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "unwritable spool: exit 0, logged",
    async () => {
      const h = tmp();
      try {
        const spool = join(h, "spool");
        mkdirSync(spool, { recursive: true });
        chmodSync(spool, 0o555);
        const t0 = Date.now();
        const r = await runHook(STOP, { home: h });
        chmodSync(spool, 0o755);
        expect(Date.now() - t0).toBeLessThan(3_000);
        expect(r.code).toBe(0);
        expect(r.stdout.length).toBe(0);
        expect(readFileSync(join(h, "hook-errors.log"), "utf8")).toContain("spool-error");
      } finally {
        rmSync(h, { recursive: true, force: true });
      }
    },
  );
});

describe("R1.2 session and event ids are bounded", () => {
  it("a 100 KB session_id is rejected, never written, and logged by reason", async () => {
    const h = tmp();
    try {
      const r = await runHook(
        JSON.stringify({ session_id: "x".repeat(100_000), hook_event_name: "Stop" }),
        { home: h },
      );
      expect(r.code).toBe(0);
      expect(r.stdout.length).toBe(0);
      expect(existsSync(join(h, "spool"))).toBe(false);
      const log = readFileSync(join(h, "hook-errors.log"), "utf8");
      expect(log).toMatch(/id-too-long/);
      expect(log).not.toMatch(/xxxx/);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });
  it("a 256-char id is accepted and stays under the line cap", async () => {
    const h = tmp();
    try {
      await runHook(JSON.stringify({ session_id: "y".repeat(256), hook_event_name: "Stop" }), {
        home: h,
      });
      const lines = readSpoolLines(join(h, "spool"));
      expect(lines).toHaveLength(1);
      expect(Buffer.byteLength(lines[0]!)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("D2/D3 paths and host come from argv, not env", () => {
  it("dist/hook.mjs does not read SESSIONDECK_HOME or XDG_STATE_HOME, and carries no zod", () => {
    const src = readFileSync(hookPath, "utf8");
    expect(src).not.toContain("SESSIONDECK_HOME");
    expect(src).not.toContain("XDG_STATE_HOME");
    expect(src).not.toMatch(/ZodError|zod/);
  });

  it("without --home the platform default is used and env decoys are ignored", async () => {
    const root = tmp();
    try {
      const decoy = join(root, "decoy");
      const fake = join(root, "fakehome");
      mkdirSync(fake);
      const r = await runHook(STOP, {
        env: {
          HOME: fake,
          USERPROFILE: fake,
          LOCALAPPDATA: join(fake, "lad"),
          SESSIONDECK_HOME: decoy,
          XDG_STATE_HOME: decoy,
        },
      });
      expect(r.code).toBe(0);
      const spool = win32
        ? join(fake, "lad", "sessiondeck", "spool")
        : join(fake, ".local", "state", "sessiondeck", "spool");
      expect(readSpoolLines(spool)).toHaveLength(1);
      expect(existsSync(decoy)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--host is stamped on every line; without it the hostname fallback applies", async () => {
    const h = tmp();
    try {
      const start = JSON.stringify({ session_id: "s", hook_event_name: "SessionStart" });
      await runHook(start, { home: h, host: "my-box-wsl" });
      await runHook(STOP, { home: h });
      const envs = readSpoolLines(join(h, "spool")).map((l) => JSON.parse(l));
      expect(envs.map((e) => e.host)).toEqual(["my-box-wsl", "my-box-wsl", resolveHostName()]);
      expect(envs.map((e) => e.kind)).toEqual(["hook", "liveness", "hook"]);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe.skipIf(win32)("spool hardening (POSIX)", () => {
  it("new probe home, spool dir and parents are 0700; files are 0600", async () => {
    const root = tmp();
    try {
      const h = join(root, "state", "sessiondeck");
      await runHook(STOP, { home: h });
      await runHook("not json", { home: h });
      expect(statSync(join(root, "state")).mode & 0o777).toBe(0o700);
      expect(statSync(h).mode & 0o777).toBe(0o700);
      expect(statSync(join(h, "spool")).mode & 0o777).toBe(0o700);
      const day = readdirSync(join(h, "spool")).filter((f) => f.endsWith(".jsonl"));
      expect(day).toHaveLength(1);
      expect(statSync(join(h, "spool", day[0]!)).mode & 0o777).toBe(0o600);
      expect(statSync(join(h, "hook-errors.log")).mode & 0o777).toBe(0o600);
      expect(readdirSync(join(h, "spool")).filter((f) => f.startsWith("."))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a symlinked day file is not followed: target unchanged, exit 0", async () => {
    const h = tmp();
    try {
      const target = join(h, "victim.txt");
      writeFileSync(target, "untouched\n");
      mkdirSync(join(h, "spool"), { recursive: true });
      const link = join(h, "spool", dayFileName(Date.now()));
      symlinkSync(target, link);
      const r = await runHook(STOP, { home: h });
      expect(r.code).toBe(0);
      expect(r.stdout.length).toBe(0);
      expect(readFileSync(target, "utf8")).toBe("untouched\n");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(h, "hook-errors.log"), "utf8")).toMatch(/spool-error/);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it("a symlinked error log is not followed or reset", async () => {
    const h = tmp();
    try {
      const target = join(h, "victim.txt");
      writeFileSync(target, "untouched\n");
      symlinkSync(target, join(h, "hook-errors.log"));
      const r = await runHook("not json", { home: h });
      expect(r.code).toBe(0);
      expect(readFileSync(target, "utf8")).toBe("untouched\n");
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it("a day file that is a directory is refused, exit 0", async () => {
    const h = tmp();
    try {
      mkdirSync(join(h, "spool", dayFileName(Date.now())), { recursive: true });
      const r = await runHook(STOP, { home: h });
      expect(r.code).toBe(0);
      expect(r.stdout.length).toBe(0);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });
});
