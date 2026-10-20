import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseSpoolLine } from "../src/spool.ts";
import { renderStatusLine } from "../src/statusline/render.ts";
import { setWindowsUtf8 } from "../src/win-utf8.ts";
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
const future = Math.floor(Date.now() / 1000) + 3600;
const past = Math.floor(Date.now() / 1000) - 3600;

describe("R1.9 statusline fixtures", () => {
  it("has fixtures", () => expect(fixtureFiles.length).toBe(20));
  for (const f of fixtureFiles) {
    it(`${f}: exit 0, one non-empty line with ctx and 5h, spool line appended`, async () => {
      const h = mkdtempSync(join(tmpdir(), "sd-sl-f-"));
      try {
        const r = await run(readFileSync(join(FIX, f)), h);
        expect(r.code).toBe(0);
        const out = lines(r.stdout);
        expect(out).toHaveLength(1);
        expect(out[0]).toContain("ctx");
        expect(out[0]).toContain("5h");
        expect(r.stderr.length).toBe(0);
        const sp = readSpoolLines(join(h, "spool"));
        expect(sp).toHaveLength(1);
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
    expect(lines(r.stdout)[0]).toMatch(/\| ctx 38% \| 5h 78% \| 7d 35%/);
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

describe("renderStatusLine", () => {
  const now = 1_000_000_000_000;
  it("computes context % when used_percentage is missing", () => {
    const s = renderStatusLine(
      {
        model: { display_name: "M" },
        context_window: {
          context_window_size: 1000,
          current_usage: { input_tokens: 100, cache_read_input_tokens: 150 },
        },
      },
      now,
    );
    expect(s).toBe("M | ctx 25% | 5h n/a | 7d n/a");
  });
  it("out-of-range used_percentage is n/a", () => {
    const s = renderStatusLine(
      { rate_limits: { five_hour: { used_percentage: 1792101600 } } },
      now,
    );
    expect(s).toContain("5h n/a");
  });
  it("strips control characters from the model name and shows cost and effort", () => {
    const s = renderStatusLine(
      { model: "a\nb\u001b[31m", effort: { level: "high" }, cost: { total_cost_usd: 1.234 } },
      now,
    );
    expect(s.split("\n")).toHaveLength(1);
    expect(s).toContain("high");
    expect(s).toContain("$1.23");
    expect(s).not.toContain("\u001b");
  });
  it.each([null, 5, "x", [], undefined, { model: 7, context_window: 3, rate_limits: 4 }])(
    "garbage %j still renders a line",
    (v) => {
      const s = renderStatusLine(v, now);
      expect(s.length).toBeGreaterThan(0);
    },
  );
});

describe("win-utf8", () => {
  it("is a no-op off win32", () => {
    let called = false;
    setWindowsUtf8("linux", () => (called = true));
    expect(called).toBe(false);
  });
  it("runs chcp.com 65001 on win32 and swallows failure", () => {
    const seen: string[][] = [];
    setWindowsUtf8("win32", (f, a) => {
      seen.push([f, ...a]);
      throw new Error("denied");
    });
    expect(seen).toEqual([["chcp.com", "65001"]]);
  });
  it.skipIf(process.platform !== "win32")("non-ASCII model name survives", async () => {
    const r = await run(JSON.stringify({ session_id: "s", model: "Modèle 日本語" }), home);
    expect(r.stdout.toString("utf8")).toContain("Modèle 日本語");
  });
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
        expect(r.stderr.toString()).not.toMatch(/\bat .*\(/);
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
