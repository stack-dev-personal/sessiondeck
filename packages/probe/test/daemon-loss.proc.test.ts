import { describe, expect, it } from "vitest";
import { runKillScenario, runOutageScenario } from "../scripts/loss-lib.mjs";

// Drives dist/daemon.mjs (built by test/global-setup.ts) as a real process. The scenarios are the
// ones scripts/harness-loss.mjs prints. SIGKILL on POSIX, taskkill /F on Windows.
describe("R1.4 daemon kill/restart under load", () => {
  it("500 envelopes: all accepted, 0 duplicates, 0 gaps, in order, across 3 daemon kills, a hub kill and a lost ack", async () => {
    const r = await runKillScenario({ total: 500 });
    expect(r.sent).toBe(500);
    expect(r.accepted).toBe(500);
    expect(r.duplicates).toBe(0);
    expect(r.gaps).toBe(0);
    expect(r.order).toBe("ok");
    expect(r.resent_ids).toBeGreaterThan(0); // the lost ack forced a verbatim resend
  });
});

describe("R1.5 hub outage", () => {
  it("nothing is delivered while the hub is down; everything arrives in order after it returns", async () => {
    // 8 s stands in for the 10 minutes of R1.5; the harness runs 15 s, SD_OUTAGE_MS=600000 the real thing.
    const r = await runOutageScenario({ total: 500, outageMs: 8000 });
    expect(r.delivered_during_outage).toBe(0);
    expect(r.recovered).toBe(true);
    expect(r.accepted).toBe(500);
    expect(r.duplicates).toBe(0);
    expect(r.gaps).toBe(0);
    expect(r.order).toBe("ok");
  });
});
