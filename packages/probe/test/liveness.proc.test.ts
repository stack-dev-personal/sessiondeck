// R1.7 with a real process: a child node process stands in for claude, the real monitor (real
// process.kill probe, default 10 s tick, real lookup) must queue alive:false within 15 s of its
// death. Runs on Linux and in the windows-latest CI job (PowerShell lookup on registration).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope } from "@sessiondeck/contract";
import { afterEach, describe, expect, it } from "vitest";
import { LivenessMonitor } from "../src/daemon/liveness.ts";
import { buildEnvelope } from "../src/envelope.ts";
import type { SpoolLine } from "../src/spool-format.ts";

let tmp = "";
let child: ChildProcess | undefined;
afterEach(() => {
  child?.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
});

describe("R1.7 real process", () => {
  it("detects a killed pid and queues alive:false within 15 s", { timeout: 60_000 }, async () => {
    tmp = mkdtempSync(join(tmpdir(), "sd-liveness-proc-"));
    child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const pid = child.pid!;
    const out: SpoolLine[] = [];
    const m = new LivenessMonitor({
      statePath: join(tmp, "liveness.json"),
      enqueue: (l) => void out.push(l),
      host: "h",
      sessionsDir: join(tmp, "sessions"),
    });
    await m.start();
    const env: Envelope = {
      ...buildEnvelope({
        kind: "liveness",
        host: "h",
        payload: { pid, alive: true },
        session_id: "real-proc-session",
      }),
      seq: 0,
    };
    await m.registerSession("real-proc-session", pid, env.ts);
    expect(m.snapshot()[0]).toMatchObject({ pid, state: "tracking" });
    // A node process is not named "claude", so it is on probation until the first tick finds it alive.
    const regAt = Date.now();
    while (m.snapshot()[0]?.probation === true && Date.now() - regAt < 20_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(m.snapshot()[0]).toMatchObject({ pid, state: "tracking" });
    expect(m.snapshot()[0]?.probation).toBeUndefined();
    const exited = new Promise<void>((r) => child!.once("exit", () => r()));
    const killedAt = Date.now();
    child.kill("SIGKILL");
    await exited;
    while (out.length === 0 && Date.now() - killedAt < 20_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const took = Date.now() - killedAt;
    await m.stop();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "liveness",
      session_id: "real-proc-session",
      payload: { pid, alive: false },
    });
    expect(took).toBeLessThanOrEqual(15_000);
  });
});
