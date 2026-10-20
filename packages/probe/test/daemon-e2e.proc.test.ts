import { describe, expect, it } from "vitest";
import { runDaemonE2E } from "../scripts/harness-daemon-e2e.mjs";

// Drives dist/daemon.mjs (built by test/global-setup.ts) with the transcript tailer and the liveness
// monitor wired in, against a stub hub, a temp probe home and a temp CLAUDE_CONFIG_DIR.
describe("daemon end to end (R1.4-R1.7)", () => {
  it("hook envelopes, transcript lines, a death and a heartbeat arrive once; a restart redelivers nothing", async () => {
    const r = await runDaemonE2E();
    const failed = r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    expect(failed).toEqual([]);
    expect(r.checks.length).toBeGreaterThanOrEqual(8);
  });
});
