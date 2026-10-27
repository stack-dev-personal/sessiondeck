import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { parseSpoolLine } from "../src/spool.ts";
import {
  describeExe,
  exePathFor,
  fixturesDir,
  probeRoot,
  readSpoolLines,
  runHook,
} from "./helpers.ts";

// R1.9 against the Bun-compiled statusline and subagents (the programs `probe install` registers by
// default). Each case runs the Node bundle and the exe on the same stdin and requires exit 0 and
// byte-identical stdout (statusline) or empty stdout (subagents). Fails instead of skipping when
// SD_REQUIRE_EXE=1.
const FALLBACK = "sessiondeck\n";
const VOLATILE = new Set(["id", "ts", "received_at"]);
const dist = (n: string): string => join(probeRoot, "dist", `${n}.mjs`);

const dirs: string[] = [];
const fresh = (): string => {
  const d = mkdtempSync(join(tmpdir(), "sd-sl-exe-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Same stdin through the Node bundle and the exe, each with its own empty home. */
async function both(kind: "statusline" | "subagents", input: Buffer | string) {
  const exe = exePathFor(kind) as string;
  const nh = fresh();
  const eh = fresh();
  const [n, e] = await Promise.all([
    runHook(input, { home: nh, host: "parity" }, dist(kind)),
    runHook(input, { home: eh, host: "parity" }, exe),
  ]);
  return { n, e, nh, eh };
}

function stripVolatile(line: string): string {
  const o = JSON.parse(line) as Record<string, unknown>;
  return JSON.stringify(
    Object.entries(o)
      .filter(([k]) => !VOLATILE.has(k))
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

const jsonFiles = (dir: string): string[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => join(dir, f));

describeExe("R1.9 [exe] statusline", exePathFor("statusline"), () => {
  for (const file of jsonFiles(join(fixturesDir, "statusLine"))) {
    it(`${basename(file)}: exit 0, stdout identical to the Node bundle`, async () => {
      const { n, e } = await both("statusline", readFileSync(file));
      expect(e.code).toBe(0);
      expect(e.stderr.length).toBe(0);
      expect(e.stdout.toString("hex")).toBe(n.stdout.toString("hex"));
      expect(e.stdout.toString("utf8").split("\n").filter(Boolean)).toHaveLength(1);
    });
  }

  it("non-ASCII model name: UTF-8 bytes identical to the Node bundle (win-utf8 path)", async () => {
    const input = JSON.stringify({
      session_id: "s-utf8",
      model: { id: "m", display_name: "Opus \u2728 caf\u00e9 \u65e5\u672c" },
    });
    const { n, e } = await both("statusline", input);
    expect(e.code).toBe(0);
    expect(e.stdout.toString("hex")).toBe(n.stdout.toString("hex"));
  });

  for (const [name, input] of [
    ["empty stdin", Buffer.alloc(0)],
    ["malformed JSON", Buffer.from("{not json")],
    ["JSON null", Buffer.from("null")],
  ] as const) {
    it(`${name}: exit 0, fallback line identical to the Node bundle`, async () => {
      const { n, e } = await both("statusline", input);
      expect(e.code).toBe(0);
      expect(e.stdout.toString()).toBe(n.stdout.toString());
      expect(e.stdout.toString()).toBe(FALLBACK);
    });
  }

  it("never-closing stdin is bounded, exit 0, fallback line", async () => {
    await expectBounded(exePathFor("statusline") as string, FALLBACK);
  });
});

describeExe("R1.9 [exe] subagents", exePathFor("subagents"), () => {
  const sub = jsonFiles(join(fixturesDir, "subagentStatusLine"));

  it("has fixtures", () => expect(sub.length).toBeGreaterThan(0));
  for (const file of sub) {
    it(`${basename(file)}: exit 0, empty stdout, same spool line as the Node bundle`, async () => {
      const { n, e, nh, eh } = await both("subagents", readFileSync(file));
      expect(e.code).toBe(0);
      expect(e.stdout.length).toBe(0);
      expect(e.stderr.length).toBe(0);
      const el = readSpoolLines(join(eh, "spool"));
      const nl = readSpoolLines(join(nh, "spool"));
      expect(n.stdout.length).toBe(0);
      expect(el).toHaveLength(1);
      expect(parseSpoolLine(el[0] as string).ok).toBe(true);
      expect(stripVolatile(el[0] as string)).toBe(stripVolatile(nl[0] as string));
    });
  }

  for (const [name, input] of [
    ["empty stdin", Buffer.alloc(0)],
    ["malformed JSON", Buffer.from("{not json")],
  ] as const) {
    it(`${name}: exit 0, empty stdout`, async () => {
      const { e } = await both("subagents", input);
      expect(e.code).toBe(0);
      expect(e.stdout.length).toBe(0);
    });
  }

  it("never-closing stdin is bounded, exit 0, empty stdout", async () => {
    await expectBounded(exePathFor("subagents") as string, "");
  });
});

async function expectBounded(exe: string, expectOut: string): Promise<void> {
  const h = fresh();
  const t0 = Date.now();
  const child = spawn(exe, ["--home", h, "--host", "t"], {
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
}
