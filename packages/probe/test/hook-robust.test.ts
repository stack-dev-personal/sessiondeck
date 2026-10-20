import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EnvelopeSchema } from "@sessiondeck/contract";
import { fixturePerEvent, readSpoolLines, runHook } from "./helpers.ts";

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "sd-robust-"));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const env = () => ({ SESSIONDECK_HOME: home });

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
      const r = await runHook(input, env());
      expect(r.code).toBe(0);
      expect(r.stdout.toString()).toBe("");
      expect(r.stderr.toString()).toBe("");
    });
  }

  for (const { event, file } of fixturePerEvent()) {
    it(`exit 0, empty stdout: fixture ${event}`, async () => {
      const r = await runHook(readFileSync(file), env());
      expect(r.code).toBe(0);
      expect(r.stdout.toString()).toBe("");
      expect(r.stderr.toString()).toBe("");
    });
  }

  it("fixtures landed in the spool as valid envelopes, 1 MB payload as a marker", () => {
    const lines = readSpoolLines(join(home, "spool"));
    expect(lines.length).toBeGreaterThan(13);
    for (const l of lines) {
      expect(Buffer.byteLength(l)).toBeLessThanOrEqual(64 * 1024);
      expect(EnvelopeSchema.safeParse(JSON.parse(l)).success).toBe(true);
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

  it("SESSIONDECK_HOME pointing at a file: still exit 0, no stdout", async () => {
    const file = join(home, "iam-a-file");
    writeFileSync(file, "x");
    const r = await runHook(readFileSync(fixturePerEvent()[0]!.file), { SESSIONDECK_HOME: file });
    expect(r.code).toBe(0);
    expect(r.stdout.toString()).toBe("");
    expect(r.stderr.toString()).toBe("");
    expect(existsSync(join(file, "spool"))).toBe(false);
  });

  it("never-closing stdin does not hang the hook", async () => {
    const t0 = Date.now();
    const { spawn } = await import("node:child_process");
    const { hookPath } = await import("./helpers.ts");
    const code = await new Promise<number | null>((resolve) => {
      const c = spawn(process.execPath, [hookPath], {
        env: { ...process.env, ...env() },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      c.on("close", resolve); // stdin deliberately left open
    });
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});
