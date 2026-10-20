// U4a review iteration 1: daemon wiring (component start failures, start order).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "@sessiondeck/contract";
import { type DaemonHandle, startDaemon } from "../src/daemon/index.ts";
import { TranscriptTailer } from "../src/daemon/transcript.ts";
import { buildEnvelope } from "../src/envelope.ts";
import { acquireLock } from "../src/daemon/lock.ts";
import { daemonLockPath, spoolDir } from "../src/paths.ts";
import { appendSpoolLines } from "../src/spool-writer.ts";

let home: string;
const open: DaemonHandle[] = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sd-review3-"));
});
afterEach(async () => {
  for (const d of open.splice(0)) await d.kill();
  rmSync(home, { recursive: true, force: true });
});

const cfg = { hubUrl: "http://127.0.0.1:9", token: "secret-token", host: "h" };
const fast = { pollMs: 5, batchMs: 20, heartbeatMs: 0, rng: () => 0 };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !cond()) await sleep(10);
  if (!cond()) throw new Error("timed out waiting");
}
const hookLine = (n: number) =>
  buildEnvelope({
    kind: "hook",
    host: "h",
    session_id: "s1",
    hook_event_name: "PostToolUse",
    payload: { n },
    ts: Date.now(),
  });
/** True while a daemon holds the lock (a probe acquire fails); a successful probe is released. */
function lockHeld(): boolean {
  const l = acquireLock(daemonLockPath(home));
  l?.release();
  return l === undefined;
}

describe("U4a review: component failures do not take the daemon down (R1)", () => {
  it("an unreadable offsets file leaves forwarding running and the lock released on stop", async () => {
    mkdirSync(join(home, "daemon", "transcript-offsets.json"), { recursive: true }); // EISDIR
    const bodies: Envelope[] = [];
    const f = (async (_u: unknown, init?: RequestInit) => {
      bodies.push(...(JSON.parse(String(init?.body)) as { envelopes: Envelope[] }).envelopes);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const seen: string[] = [];
    const d = await startDaemon({
      home,
      config: cfg,
      fetch: f,
      ...fast,
      components: [
        new TranscriptTailer({
          statePath: join(home, "daemon", "transcript-offsets.json"),
          projectsDir: join(home, "projects"),
          pollMs: 0,
        }),
        { name: "other", onSpoolLine: (e) => seen.push(e.id) },
      ],
    });
    expect(d).toBeDefined();
    open.push(d!);
    appendSpoolLines(spoolDir(home), [hookLine(1)]);
    await waitFor(() => bodies.some((b) => b.kind === "hook") && seen.length === 1);
    expect(lockHeld()).toBe(true);
    await d!.stop();
    expect(lockHeld()).toBe(false);
  });

  it("a fatal start failure releases the lock", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "spool"), "not a directory");
    await expect(startDaemon({ home, config: cfg, ...fast })).rejects.toThrow();
    expect(lockHeld()).toBe(false);
  });
});

describe("U4a review: components start before they see spool lines (R2)", () => {
  it("a journaled batch is not tapped before start()", async () => {
    const mk = (id: string, seq: number): Envelope =>
      ({ ...hookLine(seq), id, seq }) as unknown as Envelope;
    mkdirSync(join(home, "daemon"), { recursive: true });
    writeFileSync(
      join(home, "daemon", "state.json"),
      JSON.stringify({
        v: 1,
        next_seq: 0,
        pending: { first_seq: 0, envelopes: [mk("A", 0), mk("B", 1)], spool_from: 0 },
      }),
    );
    const order: string[] = [];
    const f = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    const d = await startDaemon({
      home,
      config: cfg,
      fetch: f,
      ...fast,
      components: [
        {
          name: "t",
          start: async () => {
            await sleep(30);
            order.push("start");
          },
          onSpoolLine: (e) => order.push(e.id),
        },
      ],
    });
    open.push(d!);
    await waitFor(() => order.length >= 2 && d!.pending() === 0);
    expect(order[0]).toBe("start");
  });
});
