import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dayFileName } from "../src/paths.ts";
import { parseSpoolLine } from "../src/spool.ts";
import { deriveState, readTail } from "../src/statusline/state.ts";
import { fixturesDir, probeRoot, readSpoolLines, runHook } from "./helpers.ts";

const statuslinePath = join(probeRoot, "dist", "statusline.mjs");
const subagentsPath = join(probeRoot, "dist", "subagents.mjs");
const run = (stdin: Buffer | string | null, home: string, script = statuslinePath) =>
  runHook(stdin, { home, host: "testhost" }, script);

const FIX = join(fixturesDir, "statusLine");
const fixtureFiles = readdirSync(FIX)
  .filter((f) => f.endsWith(".json"))
  .sort();
const load = (
  f: string,
): Record<
  string,
  any // eslint-disable-line @typescript-eslint/no-explicit-any
> => JSON.parse(readFileSync(join(FIX, f), "utf8"));

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "sd-sl-"));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const lines = (b: Buffer): string[] => b.toString("utf8").split("\n").filter(Boolean);
function seedHook(h: string, sid: string, event: string, extra: object = {}, ts = Date.now()) {
  const dir = join(h, "spool");
  mkdirSync(dir, { recursive: true });
  const line = {
    v: 1,
    id: "x",
    kind: "hook",
    host: "t",
    os: "linux",
    session_id: sid,
    ts,
    hook_event_name: event,
    payload: { session_id: sid, hook_event_name: event },
    ...extra,
  };
  writeFileSync(join(dir, dayFileName(ts)), JSON.stringify(line) + "\n", { flag: "a" });
}
const future = Math.floor(Date.now() / 1000) + 3600;
const past = Math.floor(Date.now() / 1000) - 3600;

describe("R1.9 statusline fixtures", () => {
  it("has fixtures", () => expect(fixtureFiles.length).toBe(20));
  for (const f of fixtureFiles) {
    it(`${f}: exit 0, one line with state, ctx and 5h, spool line appended`, async () => {
      const h = mkdtempSync(join(tmpdir(), "sd-sl-f-"));
      try {
        const raw = readFileSync(join(FIX, f));
        const sid = JSON.parse(raw.toString("utf8")).session_id as string;
        // Without a hook line for the session: n/a.
        const r = await run(raw, h);
        expect(r.code).toBe(0);
        const out = lines(r.stdout);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatch(/^n\/a \| /);
        // With a preceding PermissionRequest hook line: waiting_permission.
        seedHook(h, sid, "PermissionRequest");
        const r2 = await run(raw, h);
        expect(lines(r2.stdout)[0]).toMatch(/^waiting_permission \| /);
        expect(out[0]).toContain("ctx");
        expect(out[0]).toContain("5h");
        expect(r.stderr.length).toBe(0);
        const sp = readSpoolLines(join(h, "spool"));
        const r0 = parseSpoolLine(sp[0] as string);
        const parsed = r0.ok ? r0.line : null;
        expect(parsed?.kind).toBe("statusline");
        expect(parsed?.host).toBe("testhost");
      } finally {
        rmSync(h, { recursive: true, force: true });
      }
    });
  }

  it("rate_limits with a future reset shows numbers", async () => {
    const p = load("16-max-five-hour.json");
    p.rate_limits.five_hour = { used_percentage: 78, resets_at: future };
    p.rate_limits.seven_day = { used_percentage: 35, resets_at: future };
    const r = await run(JSON.stringify(p), home);
    expect(lines(r.stdout)[0]).toMatch(/^n\/a \| .*\| ctx 38% \| 5h 78% \| 7d 35%/);
    expect(lines(r.stdout)[0]).toContain("Fable 5.1");
  });

  it("stale resets_at shows n/a", async () => {
    const p = load("16-max-five-hour.json");
    p.rate_limits.five_hour = { used_percentage: 78, resets_at: past };
    const r = await run(JSON.stringify(p), home);
    expect(lines(r.stdout)[0]).toContain("5h n/a");
  });

  it("absent rate_limits shows 5h n/a", async () => {
    const p = load("16-max-five-hour.json");
    delete p.rate_limits;
    const r = await run(JSON.stringify(p), home);
    expect(lines(r.stdout)[0]).toContain("5h n/a");
  });
});

describe("win-utf8 (real process)", () => {
  it.skipIf(process.platform !== "win32")("non-ASCII model name survives", async () => {
    const r = await run(JSON.stringify({ session_id: "s", model: "Modèle 日本語" }), home);
    expect(r.stdout.toString("utf8")).toContain("Modèle 日本語");
  });
});

describe("non-regular day files never hang the status line (review round 2)", () => {
  const payload = JSON.stringify({ session_id: "sess-1", model: "M" });
  const dayPath = (h: string): string => join(h, "spool", dayFileName(Date.now()));

  it.skipIf(process.platform === "win32")(
    "a FIFO named as the day file: n/a within a time bound",
    async () => {
      const h = mkdtempSync(join(tmpdir(), "sd-sl-fifo-"));
      try {
        mkdirSync(join(h, "spool"));
        execFileSync("mkfifo", [dayPath(h)]);
        const t0 = Date.now();
        expect(deriveState(join(h, "spool"), "sess-1")).toBe("n/a");
        expect(readTail(dayPath(h))).toBeNull();
        const r = await run(payload, h);
        expect(r.code).toBe(0);
        expect(lines(r.stdout)[0]).toMatch(/^n\/a \| /);
        expect(Date.now() - t0).toBeLessThan(5000);
      } finally {
        rmSync(h, { recursive: true, force: true });
      }
    },
  );
  it.skipIf(process.platform === "win32")(
    "a symlinked day file: n/a, not followed or appended to",
    async () => {
      const h = mkdtempSync(join(tmpdir(), "sd-sl-sym-"));
      try {
        mkdirSync(join(h, "spool"));
        const real = join(h, "real.jsonl");
        writeFileSync(real, "");
        symlinkSync(real, dayPath(h));
        const r = await run(payload, h);
        expect(r.code).toBe(0);
        expect(lines(r.stdout)[0]).toMatch(/^n\/a \| /);
        expect(readFileSync(real, "utf8")).toBe("");
      } finally {
        rmSync(h, { recursive: true, force: true });
      }
    },
  );
});

const FALLBACK = "sessiondeck\n";

describe("robustness (both entries)", () => {
  const bad: [string, Buffer | string | null][] = [
    ["empty", ""],
    ["closed stdin", null],
    ["malformed", "{not json"],
    ["array", "[]"],
    ["invalid utf-8", Buffer.from([0x7b, 0xff, 0xfe, 0x7d])],
    ["1 MB junk", Buffer.alloc(1024 * 1024, "x")],
    ["1 MB valid object", JSON.stringify({ session_id: "s", pad: "x".repeat(1024 * 1024) })],
  ];
  for (const [name, input] of bad) {
    it(`statusline: ${name} -> fallback line, exit 0`, async () => {
      const h = mkdtempSync(join(tmpdir(), "sd-sl-b-"));
      try {
        const r = await run(input, h);
        expect(r.code).toBe(0);
        if (name === "1 MB valid object") expect(lines(r.stdout)[0]).toContain("ctx");
        else expect(r.stdout.toString()).toBe(FALLBACK);
        expect(r.stderr.length).toBe(0);
      } finally {
        rmSync(h, { recursive: true, force: true });
      }
    });
    it(`subagents: ${name} -> nothing, exit 0`, async () => {
      const h = mkdtempSync(join(tmpdir(), "sd-sa-b-"));
      try {
        const r = await run(input, h, subagentsPath);
        expect(r.code).toBe(0);
        expect(r.stdout.length).toBe(0);
        expect(r.stderr.length).toBe(0);
      } finally {
        rmSync(h, { recursive: true, force: true });
      }
    });
  }

  it("unwritable home (a file) -> still prints, exit 0", async () => {
    const h = mkdtempSync(join(tmpdir(), "sd-sl-u-"));
    const file = join(h, "notadir");
    writeFileSync(file, "x");
    try {
      const p = JSON.stringify({ session_id: "s", model: "M" });
      const a = await run(p, file);
      expect(a.code).toBe(0);
      expect(lines(a.stdout)[0]).toContain("ctx");
      const b = await run(p, file, subagentsPath);
      expect(b.code).toBe(0);
      expect(b.stdout.length).toBe(0);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  for (const [label, script, expectOut] of [
    ["statusline", statuslinePath, FALLBACK],
    ["subagents", subagentsPath, ""],
  ] as const) {
    it(`${label}: never-closing stdin is bounded`, async () => {
      const h = mkdtempSync(join(tmpdir(), "sd-sl-h-"));
      try {
        const t0 = Date.now();
        const child = spawn(process.execPath, [script, "--home", h, "--host", "t"], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        const out: Buffer[] = [];
        child.stdout.on("data", (c: Buffer) => out.push(c));
        child.stdin.write("{");
        const code = await new Promise((res) => child.on("close", res));
        expect(code).toBe(0);
        expect(Date.now() - t0).toBeLessThan(8000);
        expect(Buffer.concat(out).toString()).toBe(expectOut);
      } finally {
        rmSync(h, { recursive: true, force: true });
      }
    });
  }
});

describe("subagents spool", () => {
  it("appends one subagents line per call and prints nothing", async () => {
    const h = mkdtempSync(join(tmpdir(), "sd-sa-"));
    try {
      const raw = readFileSync(
        join(
          fixturesDir,
          "subagentStatusLine",
          readdirSync(join(fixturesDir, "subagentStatusLine")).sort()[0] as string,
        ),
      );
      for (let i = 0; i < 2; i += 1) {
        const r = await run(raw, h, subagentsPath);
        expect(r.code).toBe(0);
        expect(r.stdout.length).toBe(0);
      }
      const sp = readSpoolLines(join(h, "spool"));
      expect(sp).toHaveLength(2);
      const r0 = parseSpoolLine(sp[0] as string);
      const p = r0.ok ? r0.line : null;
      expect(p?.kind).toBe("subagents");
      expect(p?.session_id).toBe("fdafa657-e191-4646-88ad-7ae634752456");
      expect((p?.payload as { tasks: unknown[] }).tasks.length).toBeGreaterThan(0);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });
});
