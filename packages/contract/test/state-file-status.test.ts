import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GATE_STATES,
  SPRINT_SESSION_STATES,
  SPRINT_STATES,
  SessionStatusSchema,
  SprintStatusSchema,
  StateFileError,
  formatTimestamp,
  readSessionStatus,
  readSprintStatus,
  readStatusFile,
  sessionStatusPath,
  sprintStatusPath,
  writeSessionStatus,
  writeSprintStatus,
} from "../src/state-file";

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "sd-status-"));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const CLOCK = { now: () => new Date("2026-10-12T01:02:03.456Z") };
const STAMP = "2026-10-12T01:02:03Z";

// The examples of PROMPT-BOOK.md section 6, with one concrete state picked from each enumeration.
const SPRINT_EXAMPLE = {
  sprint: "1",
  name: "mvp",
  branch: "sprint/1-mvp",
  state: "running",
  started_at: "2026-10-12T01:00:00Z",
  updated_at: "2026-10-12T01:00:00Z",
  sessions: {
    S1: {
      state: "green",
      branch: "p1/probe-hook",
      pr: 4,
      verify: "docs/VERIFY-P1.md",
      units_done: 5,
      units_total: 5,
      updated_at: "2026-10-12T01:00:00Z",
    },
    S2: { state: "blocked", question_file: "questions/S2.md", updated_at: "2026-10-12T01:00:00Z" },
  },
  questions: ["questions/S2.md"],
  pr: null,
  gate: { state: "pending", report: "gate/README.md" },
  needs_laptop_confirmation: ["R1.1 hook p95 on Windows"],
};

const SESSION_EXAMPLE = {
  state: "running",
  branch: "p1/probe-hook",
  pr: null,
  units_done: 2,
  units_total: 5,
  updated_at: "2026-10-12T01:00:00Z",
  current_unit: "U3",
  last_report: "reports/S1.md",
  pid: 4242,
};

describe("schemas", () => {
  it("accept the PROMPT-BOOK examples", () => {
    expect(SprintStatusSchema.parse(SPRINT_EXAMPLE)).toEqual(SPRINT_EXAMPLE);
    expect(SessionStatusSchema.parse(SESSION_EXAMPLE)).toEqual(SESSION_EXAMPLE);
  });

  it.each(SPRINT_STATES)("accept sprint state %s", (state) => {
    expect(SprintStatusSchema.safeParse({ ...SPRINT_EXAMPLE, state }).success).toBe(true);
  });

  it.each(SPRINT_SESSION_STATES)("accept session state %s", (state) => {
    expect(SessionStatusSchema.safeParse({ ...SESSION_EXAMPLE, state }).success).toBe(true);
    const sessions = { S1: { state } };
    expect(SprintStatusSchema.safeParse({ ...SPRINT_EXAMPLE, sessions }).success).toBe(true);
  });

  it.each(GATE_STATES)("accept gate state %s", (state) => {
    const gate = { state, report: "gate/README.md" };
    expect(SprintStatusSchema.safeParse({ ...SPRINT_EXAMPLE, gate }).success).toBe(true);
  });

  it("reject unknown states", () => {
    expect(SprintStatusSchema.safeParse({ ...SPRINT_EXAMPLE, state: "paused" }).success).toBe(
      false,
    );
    expect(SessionStatusSchema.safeParse({ ...SESSION_EXAMPLE, state: "paused" }).success).toBe(
      false,
    );
    const gate = { state: "maybe" };
    expect(SprintStatusSchema.safeParse({ ...SPRINT_EXAMPLE, gate }).success).toBe(false);
  });

  it("tolerate null and absent optional fields", () => {
    const minimal = { sprint: "0", name: "n", branch: "b", state: "running", updated_at: STAMP };
    expect(SprintStatusSchema.safeParse(minimal).success).toBe(true);
    const session = {
      state: "blocked",
      updated_at: STAMP,
      question_file: null,
      current_unit: null,
      pid: null,
    };
    expect(SessionStatusSchema.safeParse(session).success).toBe(true);
  });
});

describe("formatTimestamp", () => {
  it("is ISO 8601 UTC with seconds precision", () => {
    expect(formatTimestamp(new Date("2026-10-12T01:02:03.999Z"))).toBe(STAMP);
  });
});

describe("typed writers and readers", () => {
  it("stamp updated_at from the injected clock without touching the input", async () => {
    const input = { ...SPRINT_EXAMPLE, updated_at: "old" };
    const written = await writeSprintStatus(stateDir, input, CLOCK);
    expect(written.updated_at).toBe(STAMP);
    expect(input.updated_at).toBe("old");
    const sessionIn = { state: "running" };
    const session = await writeSessionStatus(stateDir, "S1", sessionIn, CLOCK);
    expect(session.updated_at).toBe(STAMP);
    expect(sessionIn).toEqual({ state: "running" });
  });

  it("round-trips extra keys", async () => {
    const extra = { worktree: "<HOME>/wt/S0c", heartbeat: { at: STAMP }, needs: [1, 2] };
    await writeSprintStatus(stateDir, { ...SPRINT_EXAMPLE, ...extra }, CLOCK);
    const sprint = await readSprintStatus(stateDir);
    expect(sprint).toMatchObject(extra);
    await writeSessionStatus(stateDir, "S1", { ...SESSION_EXAMPLE, ...extra }, CLOCK);
    expect(await readSessionStatus(stateDir, "S1")).toMatchObject(extra);
  });

  it("writes a file readStatusFile reads back, picking the schema by name", async () => {
    await writeSprintStatus(stateDir, SPRINT_EXAMPLE, CLOCK);
    await writeSessionStatus(stateDir, "S1", SESSION_EXAMPLE, CLOCK);
    expect(await readStatusFile(sprintStatusPath(stateDir))).toMatchObject({ name: "mvp" });
    expect(await readStatusFile(sessionStatusPath(stateDir, "S1"))).toMatchObject({ pid: 4242 });
    expect((await readFile(sprintStatusPath(stateDir), "utf8")).endsWith("}\n")).toBe(true);
  });

  it("refuse an invalid value before touching disk, naming the field", async () => {
    const bad = writeSprintStatus(stateDir, { ...SPRINT_EXAMPLE, state: "paused" }, CLOCK);
    await expect(bad).rejects.toMatchObject({ kind: "schema" });
    await expect(bad).rejects.toThrow(/state/);
    await expect(readSprintStatus(stateDir)).rejects.toMatchObject({ kind: "not-found" });
  });

  it("refuse hostile session ids", async () => {
    await expect(
      writeSessionStatus(stateDir, "../x", SESSION_EXAMPLE, CLOCK),
    ).rejects.toMatchObject({
      kind: "invalid-id",
    });
  });

  it("refuse secrets and write nothing", async () => {
    const leaky = { ...SESSION_EXAMPLE, last_report: "gh" + "p_" + "a".repeat(20) };
    await expect(writeSessionStatus(stateDir, "S1", leaky, CLOCK)).rejects.toMatchObject({
      kind: "secret",
    });
    await expect(readSessionStatus(stateDir, "S1")).rejects.toMatchObject({ kind: "not-found" });
  });

  it("uses the real clock by default", async () => {
    const written = await writeSessionStatus(stateDir, "S1", { state: "running" });
    expect(written.updated_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });
});

describe("readers tell failures apart", () => {
  it("missing file", async () => {
    await expect(readSessionStatus(stateDir, "S1")).rejects.toMatchObject({ kind: "not-found" });
  });

  it("invalid JSON", async () => {
    await mkdir(join(stateDir, "sessions"));
    await writeFile(sessionStatusPath(stateDir, "S1"), "{ not json");
    await expect(readSessionStatus(stateDir, "S1")).rejects.toMatchObject({ kind: "invalid-json" });
  });

  it("schema failure", async () => {
    await writeFile(sprintStatusPath(stateDir), JSON.stringify({ state: "running" }));
    const run = readSprintStatus(stateDir);
    await expect(run).rejects.toMatchObject({ kind: "schema" });
    await expect(run).rejects.toThrow(StateFileError);
  });

  it("unreadable path that exists (a directory)", async () => {
    await mkdir(sprintStatusPath(stateDir));
    await expect(readSprintStatus(stateDir)).rejects.toMatchObject({ kind: "read-failed" });
  });

  it("a root-level schema failure reads (root)", async () => {
    await writeFile(sprintStatusPath(stateDir), "[]");
    await expect(readSprintStatus(stateDir)).rejects.toThrow(/(root)/);
  });
});

describe("reader robustness and the smoke state", () => {
  it("reads a file that starts with a UTF-8 byte order mark", async () => {
    await mkdir(join(stateDir, "sessions"));
    const body = JSON.stringify({ state: "running", updated_at: STAMP });
    await writeFile(sessionStatusPath(stateDir, "S1"), "\uFEFF" + body);
    await expect(readSessionStatus(stateDir, "S1")).resolves.toMatchObject({ state: "running" });
  });

  it("accepts green as a sprint state (smoke package) and still requires the other fields", () => {
    expect(SPRINT_STATES).toContain("green");
    const smoke = { sprint: "smoke", name: "smoke", branch: "sprint/smoke", state: "green" };
    expect(SprintStatusSchema.safeParse({ ...smoke, updated_at: STAMP }).success).toBe(true);
    expect(SprintStatusSchema.safeParse({ state: "green" }).success).toBe(false);
  });

  it("does not echo a rejected value, credential or not, in a schema error", async () => {
    const secret = "gh" + "p_" + "x".repeat(24);
    const run = writeSessionStatus(stateDir, "S1", { state: "paused" });
    await expect(run).rejects.toThrow(/expected one of/);
    await expect(run).rejects.not.toThrow("paused");
    const bad = writeSessionStatus(stateDir, "S1", { state: "running", pid: secret });
    await expect(bad).rejects.toMatchObject({ kind: "secret" });
  });

  it("does not echo a credential used as an id", async () => {
    const secret = "gh" + "p_" + "x".repeat(24) + "/..";
    const run = writeSessionStatus(stateDir, secret, { state: "running" });
    await expect(run).rejects.toMatchObject({ kind: "invalid-id" });
    await expect(run).rejects.not.toThrow("x".repeat(24));
  });
});
