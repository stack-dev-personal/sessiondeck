import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  STATE_SUBDIRS,
  answerFilePath,
  assertValidId,
  ensureStateLayout,
  questionFilePath,
  reportFilePath,
  sessionStatusPath,
  sprintStateDir,
  sprintStatusPath,
  StateFileError,
} from "../src/state-file";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sd-layout-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const HOSTILE_IDS = [
  "../x",
  "..",
  "a/b",
  "a\\b",
  "C:x",
  "a\0b",
  "",
  ".hidden",
  "a.b",
  " a",
  "x".repeat(65),
];

describe("ensureStateLayout", () => {
  it("creates every directory and returns their paths", async () => {
    const stateDir = join(root, "0");
    const layout = await ensureStateLayout(stateDir);
    expect(layout.stateDir).toBe(stateDir);
    for (const [key, name] of Object.entries(STATE_SUBDIRS)) {
      expect(layout[key as keyof typeof STATE_SUBDIRS]).toBe(join(stateDir, name));
      expect((await stat(join(stateDir, name))).isDirectory()).toBe(true);
    }
    expect(Object.keys(STATE_SUBDIRS).sort()).toEqual([
      "answers",
      "gate",
      "logs",
      "prompts",
      "questions",
      "reports",
      "screens",
      "sessions",
    ]);
  });

  it("is idempotent", async () => {
    const stateDir = join(root, "0");
    const first = await ensureStateLayout(stateDir);
    const again = await ensureStateLayout(stateDir);
    expect(again).toEqual(first);
    expect((await readdir(stateDir)).length).toBe(Object.keys(STATE_SUBDIRS).length);
  });
});

describe("path helpers", () => {
  it("build the PROMPT-BOOK paths", () => {
    const dir = join(root, "1");
    expect(sprintStateDir(root, "1")).toBe(dir);
    expect(sprintStatusPath(dir)).toBe(join(dir, "status.json"));
    expect(sessionStatusPath(dir, "S9b")).toBe(join(dir, "sessions", "S9b.json"));
    expect(sessionStatusPath(dir, "FIX-1")).toBe(join(dir, "sessions", "FIX-1.json"));
    expect(questionFilePath(dir, "sprint")).toBe(join(dir, "questions", "sprint.md"));
    expect(answerFilePath(dir, "S2")).toBe(join(dir, "answers", "S2.md"));
    expect(reportFilePath(dir, "S2")).toBe(join(dir, "reports", "S2.md"));
  });

  it.each(HOSTILE_IDS)("reject the hostile id %j everywhere", (id) => {
    const attempts = [
      () => assertValidId("id", id),
      () => sprintStateDir(root, id),
      () => sessionStatusPath(root, id),
      () => questionFilePath(root, id),
      () => answerFilePath(root, id),
      () => reportFilePath(root, id),
    ];
    for (const attempt of attempts) {
      expect(attempt).toThrow(StateFileError);
      expect(attempt).toThrow(/invalid .*id/);
    }
  });
});
