import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const child = join(dirname(fileURLToPath(import.meta.url)), "lock-race-child.mjs");

function run(lockPath: string, startAt: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [child, lockPath, String(startAt), "600"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (c: Buffer) => (out += c.toString()));
    p.stderr.on("data", (c: Buffer) => (err += c.toString()));
    p.on("error", reject);
    p.on("close", () => resolve(out.trim() || `ERR ${err.slice(0, 200)}`));
  });
}

describe("R1.4 concurrent stale-lock takeover", () => {
  it("exactly one of 8 simultaneous starters wins, round after round", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sd-lockrace-"));
    try {
      for (let round = 0; round < 5; round++) {
        const lockPath = join(dir, `r${round}`, "daemon.lock");
        mkdirSync(join(dir, `r${round}`), { recursive: true });
        writeFileSync(lockPath, JSON.stringify({ pid: 2147483000, boot: 1, token: "dead" }));
        const startAt = Date.now() + 1500; // node start-up of all children is done by then
        const results = await Promise.all(Array.from({ length: 8 }, () => run(lockPath, startAt)));
        expect(
          results.filter((r) => r === "WON"),
          results.join(","),
        ).toHaveLength(1);
        expect(results.filter((r) => r === "LOST")).toHaveLength(7);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
