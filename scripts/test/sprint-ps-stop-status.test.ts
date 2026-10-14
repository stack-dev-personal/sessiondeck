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
      ],
      {
        plan: {
          "ps-a:sprint-a1": { out: "sprint-a1" },
          "network-ls:sprint-a1_default": { out: "sprint-a1_default" },
          "ps-a:sprint-d1": { out: "sprint-d1" },
          "stop:sprint-d1": { code: 1 },
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
      "ps-a",
      "stop",
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

  it("keeps the state directory", () => {
    expect(readFileSync(join(ws.state, "a1", "status.json"), "utf8")).toBe('{"state":"running"}');
  });

  it("exits 0 with a message when the container does not exist", () => {
    expect(run(2).code).toBe(0);
    expect(run(2).stdout).toContain("nothing to stop");
    expect(batch.calls.filter((c) => c.name === "sprint-a2").map((c) => c.key)).toEqual(["ps-a"]);
  });

  it("rejects bad ids with exit 2 before any docker call", () => {
    for (const i of [3, 4, 5]) {
      expect(run(i).code).toBe(2);
      expect(run(i).stderr).toContain("letters, digits, hyphen and underscore");
    }
    expect(batch.calls.some((c) => c.name === null)).toBe(false);
  });

  it("maps a docker failure to exit 5", () => {
    expect(run(6).code).toBe(5);
    expect(run(6).stderr).toContain("docker stop sprint-d1 failed");
    expect(batch.calls.some((c) => c.name === "sprint-d1" && c.key === "rm")).toBe(false);
  });
});

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
    expect(out).toMatch(/sprint\s+state\s+sessions\s+pr\s+updated_at\s+age_min/);
    expect(out).toMatch(/^1\s+running\s+2 green, 1 blocked\s+-\s+2026-10-12T01:00:00Z\s+\d+/m);
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
