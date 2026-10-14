import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BatchResult,
  makeWorkspace,
  runBatch,
  SHELL,
  SKIP_REASON,
  STATUS,
  STOP_SPRINT,
  type Workspace,
} from "./fixtures/sprint-ps/harness";
import { cleanupTempDirs, listTree } from "./helpers";

afterAll(cleanupTempDirs);

if (SHELL === undefined) console.warn(`SKIPPED: ${SKIP_REASON}`);

const SIBLING_PREFIX_ONE = "sd-1-";
// What a loose docker name filter returns for sprint 1: two real siblings and five names that
// merely contain or resemble the prefix. Only the first two may ever be touched.
const REAL_SIBLINGS_ONE = ["sd-1-s1-hub", "sd-1-s2-postgres"];
const LOOKALIKES_ONE = [
  REAL_SIBLINGS_ONE[0]!,
  "sd-10-s1-hub",
  "sd-1",
  "x-sd-1-y",
  "SD-1-s1-hub",
  REAL_SIBLINGS_ONE[1]!,
  "sd-11-s1-hub",
];

describe.skipIf(SHELL === undefined)("stop-sprint.ps1 (fake docker on PATH)", () => {
  let ws: Workspace;
  let batch: BatchResult;
  const run = (i: number) => batch.runs[i]!;
  const argvOf = (name: string) =>
    batch.calls.filter((c) => c.name?.startsWith(name)).map((c) => [c.key, ...c.argv]);

  beforeAll(() => {
    ws = makeWorkspace();
    const dir = join(ws.state, "a1");
    mkdirSync(dir);
    writeFileSync(join(dir, "status.json"), '{"state":"running"}');
    batch = runBatch(
      ws,
      STOP_SPRINT,
      [
        ["-Sprint", "a1", "-DryRun"], // 0
        ["-Sprint", "a1"], // 1
        ["-Sprint", "a2"], // 2: no such container
        ["-Sprint", ".."], // 3
        ["-Sprint", ""], // 4
        ["-Sprint", "b/c"], // 5
        ["-Sprint", "d1"], // 6: docker stop fails
        ["-Sprint", "1", "-DryRun"], // 7: main container plus siblings, with look-alikes
        ["-Sprint", "1"], // 8
        ["-Sprint", "2"], // 9: siblings only
        ["-Sprint", "a-b"], // 10: hyphens are not allowed in ids
        ["-Sprint", "3"], // 11: a sibling is auto-removed by docker stop
        ["-Sprint", "4"], // 12: everything is auto-removed by docker stop
        ["-Sprint", "6"], // 13: no container, a leftover network
        ["-Sprint", "6", "-DryRun"], // 14
      ],
      {
        plan: {
          "ps-a:sprint-a1": { out: "sprint-a1" },
          "network-ls:sprint-a1_default": { out: "sprint-a1_default" },
          "ps-a:sprint-d1": { out: "sprint-d1" },
          "stop:sprint-d1": { code: 1 },
          "ps-a:sprint-1": { out: "sprint-1" },
          [`ps-a:${SIBLING_PREFIX_ONE}`]: { out: LOOKALIKES_ONE.join("\n") },
          "ps-a:sd-2-": { out: "sd-2-s9-pg" },
          "ps-a:sprint-3": { out: "sprint-3" },
          "ps-a:sd-3-": { seq: [{ out: "sd-3-s1-pg" }, { out: "" }] },
          "network-ls:sprint-3_default": { out: "sprint-3_default" },
          "ps-a:sprint-4": { seq: [{ out: "sprint-4" }, { out: "" }] },
          "ps-a:sd-4-": { seq: [{ out: "sd-4-s1-pg" }, { out: "" }] },
          "network-ls:sprint-4_default": { out: "sprint-4_default" },
          "network-ls:sprint-6_default": { out: "sprint-6_default" },
        },
      },
    );
  }, 120_000);

  it("dry run stops nothing", () => {
    expect(run(0).code).toBe(0);
    expect(run(0).stdout).toContain("docker stop sprint-a1");
    expect(run(0).stdout).toContain("docker rm sprint-a1");
    expect(batch.calls.slice(0, 1).map((c) => c.key)).toEqual(["ps-a"]);
  });

  it("stops and removes the container and its compose network, with no volume flag", () => {
    expect(run(1).code, run(1).stderr).toBe(0);
    const stops = batch.calls.filter((c) => c.name?.startsWith("sprint-a1"));
    expect(stops.map((c) => c.key)).toEqual([
      "ps-a", // dry run
      "network-ls", // dry run previews the network removal
      "ps-a",
      "stop",
      "ps-a", // asked again: only what is still there gets removed
      "rm",
      "network-ls",
      "network-rm",
    ]);
    expect(argvOf("sprint-a1").find((a) => a[0] === "stop")).toEqual(["stop", "stop", "sprint-a1"]);
    expect(argvOf("sprint-a1").find((a) => a[0] === "rm")).toEqual(["rm", "rm", "sprint-a1"]);
    const all = batch.calls.flatMap((c) => c.argv);
    expect(all).not.toContain("-v");
    expect(all).not.toContain("--volumes");
    expect(all).not.toContain("volume");
    expect(all).not.toContain("down");
  });

  it("removes sibling test containers sd-<id>-* and only names with exactly that prefix", () => {
    const stops = batch.calls.filter(
      (c) => c.key === "stop" && c.argv.some((a) => /^sd-[12]-/.test(a)),
    );
    expect(stops.map((c) => c.argv)).toEqual([
      ["stop", ...REAL_SIBLINGS_ONE], // run 8 only: the dry run (run 7) issued nothing
      ["stop", "sd-2-s9-pg"],
    ]);
    const removes = batch.calls.filter(
      (c) => c.key === "rm" && c.argv.some((a) => /^sd-[12]-/.test(a)),
    );
    expect(removes.map((c) => c.argv)).toEqual([
      ["rm", ...REAL_SIBLINGS_ONE],
      ["rm", "sd-2-s9-pg"],
    ]);
    const touched = batch.calls
      .filter((c) => c.key === "stop" || c.key === "rm")
      .flatMap((c) => c.argv);
    for (const bystander of LOOKALIKES_ONE.filter((n) => !REAL_SIBLINGS_ONE.includes(n))) {
      expect(touched).not.toContain(bystander);
    }
    expect(touched).not.toContain("-v");
  });

  it("shows the siblings under -DryRun and still removes nothing", () => {
    expect(run(7).code, run(7).stderr).toBe(0);
    expect(run(7).stdout).toContain("docker stop sprint-1");
    expect(run(7).stdout).toContain(`docker stop ${REAL_SIBLINGS_ONE.join(" ")}`);
    expect(run(7).stdout).toContain(`docker rm ${REAL_SIBLINGS_ONE.join(" ")}`);
    expect(run(7).stdout).not.toContain("sd-10-");
    expect(run(7).stdout).not.toContain("SD-1-");
  });

  it("stops siblings even when the main container is already gone", () => {
    expect(run(9).code, run(9).stderr).toBe(0);
    expect(run(9).stdout).toContain("sd-2-s9-pg");
    expect(batch.calls.some((c) => c.argv.includes("sprint-2"))).toBe(false);
  });

  it("removes only what survives docker stop: an auto-removed sibling is not rm'd, the network still goes", () => {
    expect(run(11).code, run(11).stderr).toBe(0);
    const keys = (name: string) => batch.calls.filter((c) => c.name === name).map((c) => c.key);
    expect(keys("sd-3-s1-pg")).toEqual(["stop"]); // stopped, never rm'd
    const rms = batch.calls.filter((c) => c.key === "rm" && c.argv.includes("sprint-3"));
    expect(rms.map((c) => c.argv)).toEqual([["rm", "sprint-3"]]);
    expect(batch.calls.some((c) => c.key === "rm" && c.argv.includes("sd-3-s1-pg"))).toBe(false);
    expect(keys("sprint-3_default")).toEqual(["network-ls", "network-rm"]);
  });

  it("issues no rm at all when docker stop already removed everything, and still removes the network", () => {
    expect(run(12).code, run(12).stderr).toBe(0);
    expect(batch.calls.some((c) => c.key === "rm" && c.argv.some((a) => /-4(-|$)/.test(a)))).toBe(
      false,
    );
    expect(batch.calls.filter((c) => c.name === "sprint-4_default").map((c) => c.key)).toEqual([
      "network-ls",
      "network-rm",
    ]);
  });

  it("cleans up a leftover network even when there is no container to stop (and only previews under -DryRun)", () => {
    expect(run(13).code, run(13).stderr).toBe(0);
    expect(run(13).stdout).toContain("nothing to stop");
    expect(run(13).stdout).toContain("removed leftover network sprint-6_default");
    expect(run(14).code, run(14).stderr).toBe(0);
    expect(run(14).stdout).toContain("docker network rm sprint-6_default");
    expect(
      batch.calls.filter((c) => c.key === "network-rm" && c.name === "sprint-6_default"),
    ).toHaveLength(1);
  });

  it("keeps the state directory", () => {
    expect(readFileSync(join(ws.state, "a1", "status.json"), "utf8")).toBe('{"state":"running"}');
  });

  it("exits 0 with a message when the container does not exist", () => {
    expect(run(2).code).toBe(0);
    expect(run(2).stdout).toContain("nothing to stop");
    expect(batch.calls.filter((c) => c.name === "sprint-a2").map((c) => c.key)).toEqual(["ps-a"]);
  });

  it("rejects bad ids with exit 2 before any docker call", () => {
    for (const i of [3, 4, 5, 10]) {
      expect(run(i).code).toBe(2);
      expect(run(i).stderr).toContain("letters, digits and underscore");
    }
    expect(batch.calls.some((c) => c.name === null)).toBe(false);
  });

  it("maps a docker failure to exit 5", () => {
    expect(run(6).code).toBe(5);
    expect(run(6).stderr).toContain("docker stop sprint-d1 failed");
    expect(batch.calls.some((c) => c.name === "sprint-d1" && c.key === "rm")).toBe(false);
  });
});

const ESC = "\u001b";
const BEL = "\u0007";
const CSI = "\u009b";
// Over the 256 KiB cap in status.ps1.
const OVERSIZE_BYTES = 300_000;
const FIELD_WIDTH = 40;

describe.skipIf(SHELL === undefined)("status.ps1", () => {
  let ws: Workspace;
  let batch: BatchResult;
  let treeBefore: string[];
  let treeAfter: string[];

  beforeAll(() => {
    ws = makeWorkspace();
    const put = (rel: string, text: string) => {
      const file = join(ws.state, rel);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, text);
    };
    put(
      "1/status.json",
      JSON.stringify({
        sprint: "1",
        state: "running",
        updated_at: "2026-10-12T01:00:00Z",
        pr: null,
        sessions: { S1: { state: "green" }, S2: { state: "blocked" }, S3: { state: "green" } },
      }),
    );
    put(
      "1/sessions/S1.json",
      '{"state":"running","current_unit":"U2","updated_at":"2026-10-14T01:00:00Z"}',
    );
    put("1/sessions/S2.json", '{"state":"blo'); // half written
    put("2/status.json", '{"sprint":"2","sta'); // half written
    put("3/status.json", "[1, 2]"); // valid JSON, wrong shape
    put("4/logs/x.txt", "no status yet"); // directory without status.json
    // A prompt-injected session writes terminal escape sequences into every free-text field.
    const osc52 = `${ESC}]52;c;ZXZpbA==${BEL}${ESC}[2A${ESC}[2K`;
    put(
      "5/status.json",
      JSON.stringify({
        sprint: "5",
        state: `${osc52}green`,
        updated_at: `${ESC}[31mnot a date${CSI}`,
        pr: `${osc52}${CSI}31m`,
        sessions: { S1: { state: `${CSI}31mrunning` }, S2: { state: 7 }, S3: { state: "green" } },
        questions: [osc52],
        gate: { state: `${ESC}]0;pwn${BEL}` },
        needs_laptop_confirmation: ["a", "b"],
      }),
    );
    put(
      `5/sessions/S${CSI}[2J.json`, // a C1 control in a file name
      JSON.stringify({
        state: `${ESC}[31mrunning`,
        current_unit: `${"A".repeat(500)}${ESC}[2J`,
        updated_at: "2026-10-14T01:00:00Z",
      }),
    );
    put(`6${CSI}[2J/status.json`, '{"state":"running"}'); // a C1 control in a directory name
    put("7/status.json", `{"state":"running","pad":"${"x".repeat(OVERSIZE_BYTES)}"}`);
    put("8/status.json", JSON.stringify({ state: "RUNNING" })); // wrong case is not the enum
    put(
      "9/status.json",
      JSON.stringify({
        state: "gate",
        questions: ["questions/S2.md"],
        gate: { state: "fail" },
        needs_laptop_confirmation: ["R1.1 hook p95 on Windows", "R1.2"],
        updated_at: "2026-10-14T01:00:00Z",
      }),
    );
    treeBefore = listTree(ws.state);
    batch = runBatch(ws, STATUS, [
      ["-Root", ws.state],
      ["-Root", join(ws.state, "nothing-here")],
    ]);
    treeAfter = listTree(ws.state);
  }, 120_000);

  it("prints one table with a good, a malformed and a missing file", () => {
    const out = batch.runs[0]!.stdout;
    expect(batch.runs[0]!.code).toBe(0);
    expect(out).toMatch(/sprint\s+state\s+sessions\s+waiting\s+pr\s+updated_at\s+age_min/);
    expect(out).toMatch(
      /^1\s+running\s+2 green, 1 blocked\s+questions=0 gate=- needs_laptop_confirmation=0\s+-\s+2026-10-12T01:00:00Z\s+\d+/m,
    );
    expect(out).toMatch(/^2\s+unreadable/m);
    expect(out).toMatch(/^3\s+unreadable/m);
    expect(out).toMatch(/^4\s+no status\.json/m);
  });

  it("prints the sessions table and shows a half-written session as unreadable", () => {
    const out = batch.runs[0]!.stdout;
    expect(out).toMatch(/sprint\s+session\s+state\s+current_unit\s+updated_at\s+age_min/);
    expect(out).toMatch(/^1\s+S1\s+running\s+U2\s+2026-10-14T01:00:00Z\s+\d+/m);
    expect(out).toMatch(/^1\s+S2\s+unreadable/m);
  });

  it("shows what is waiting on the user: questions, gate state, laptop confirmations", () => {
    expect(batch.runs[0]!.stdout).toMatch(
      /^9\s+gate\s+-\s+questions=1 gate=fail needs_laptop_confirmation=2\s+-\s+2026-10-14T01:00:00Z\s+\d+/m,
    );
  });

  it("prints only printable ASCII: ESC, BEL, U+009B and an OSC 52 payload never reach the terminal", () => {
    const out = batch.runs[0]!.stdout;
    expect(batch.runs[0]!.code).toBe(0);
    expect(out).toMatch(/^[\x20-\x7e\r\n]*$/); // no C0, DEL, C1 or non-ASCII anywhere
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(BEL);
    expect(out).not.toContain(CSI);
    // The payload text is harmless once the introducer is gone; it is shown, defanged, not run.
    expect(out).toContain("?]52;c;ZXZpbA==??[2A?[2K");
  });

  it("maps state to the schema enum and shows everything else as invalid", () => {
    const out = batch.runs[0]!.stdout;
    // sprint 5: hostile state, a bad session state, a number as a session state, a hostile gate.
    expect(out).toMatch(
      /^5\s+invalid\s+2 invalid, 1 green\s+questions=1 gate=invalid needs_laptop_confirmation=2\s/m,
    );
    expect(out).toMatch(/^8\s+invalid\s/m); // RUNNING is not running
    expect(out).toMatch(/^5\s+S\?\[2J\s+invalid\s/m); // session state with ESC, and the C1 file name
  });

  it("truncates every field to the fixed width and cleans directory names", () => {
    const out = batch.runs[0]!.stdout;
    const unit = out.match(/A{3,}\S*/)![0];
    expect(unit.length).toBeLessThanOrEqual(FIELD_WIDTH);
    expect(unit.endsWith("...")).toBe(true);
    expect(out).toMatch(/^6\?\[2J\s+running\s/m);
  });

  it("does not parse an oversize file and says so", () => {
    expect(batch.runs[0]!.stdout).toMatch(/^7\s+too large\s/m);
  });

  it("says so and exits 0 when there is nothing to show", () => {
    expect(batch.runs[1]!.code).toBe(0);
    expect(batch.runs[1]!.stdout).toContain("No status files found");
  });

  it("is read-only and never calls docker", () => {
    expect(treeAfter).toEqual(treeBefore);
    expect(existsSync(join(ws.state, "nothing-here"))).toBe(false);
    expect(batch.calls).toEqual([]);
  });
});
