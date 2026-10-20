import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const child = join(dirname(fileURLToPath(import.meta.url)), "lock-race-child.mjs");

interface Starter {
  result: Promise<string>;
  stop: () => void;
}

/** A winner stays alive until the test stops it, so a slow-starting child always sees it live. */
function run(lockPath: string, startAt: number): Starter {
  const p = spawn(process.execPath, [child, lockPath, String(startAt), "120000"], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  const result = new Promise<string>((resolve, reject) => {
    p.stdout.on("data", (c: Buffer) => {
      out += c.toString();
      if (out.includes("\n")) resolve(out.trim());
    });
    p.stderr.on("data", (c: Buffer) => (err += c.toString()));
    p.on("error", reject);
    p.on("close", () => resolve(out.trim() || `ERR ${err.slice(0, 200)}`));
  });
  return { result, stop: () => p.kill() };
}

const ROUNDS = 20;
const STARTERS = 8;
const DEAD = JSON.stringify({ pid: 2147483000, boot: 1, token: "dead" });

type Setup = "stale" | "none" | "live";

function setup(kind: Setup, dir: string, round: number): string {
  const rdir = join(dir, `${kind}-${round}`);
  mkdirSync(rdir, { recursive: true });
  const lockPath = join(rdir, "daemon.lock");
  // Alternate between the current numbered format and the legacy single file.
  if (kind === "stale") writeFileSync(round % 2 ? lockPath : `${lockPath}.4`, DEAD);
  if (kind === "live") {
    const live = JSON.stringify({ pid: process.pid, token: "live" });
    writeFileSync(`${lockPath}.7`, live);
  }
  return lockPath;
}

async function race(kind: Setup): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "sd-lockrace-"));
  try {
    for (let round = 0; round < ROUNDS; round++) {
      const lockPath = setup(kind, dir, round);
      const startAt = Date.now() + 1500; // node start-up of all children is done by then
      const starters = Array.from({ length: STARTERS }, () => run(lockPath, startAt));
      const results = await Promise.all(starters.map((st) => st.result));
      for (const st of starters) st.stop();
      const won = results.filter((r) => r === "WON").length;
      expect(won, `${kind} round ${round}: ${results.join(",")}`).toBe(kind === "live" ? 0 : 1);
      expect(results.filter((r) => r === "LOST")).toHaveLength(STARTERS - won);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("R1.4 concurrent lock acquisition (8 simultaneous starters, 20 rounds)", () => {
  it("a stale lock: exactly one winner", () => race("stale"), 120_000);
  it("no lock: exactly one winner", () => race("none"), 120_000);
  it("a live lock: no winner", () => race("live"), 120_000);
});
