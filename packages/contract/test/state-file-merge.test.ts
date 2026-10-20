import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mergeSessionStatus,
  mergeSprintFields,
  mergeSprintStatus,
  sessionStatusPath,
  sprintStatusPath,
} from "../src/state-file";

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "sd-merge-"));
  await mkdir(join(stateDir, "sessions"));
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

describe("mergeSprintFields", () => {
  it("merges sessions per id and keeps the ids the override does not mention", () => {
    const current = {
      state: "running",
      sessions: { S0: { state: "green", pr: 3 }, S0b: { state: "not-started" } },
    };
    const merged = mergeSprintFields(current, {
      sessions: { S0b: { state: "running" }, S0c: { state: "running" } },
    });
    expect(merged["sessions"]).toEqual({
      S0: { state: "green", pr: 3 },
      S0b: { state: "running" },
      S0c: { state: "running" },
    });
    expect(current.sessions.S0b).toEqual({ state: "not-started" }); // input untouched
  });

  it("merges into the existing entry of the same id", () => {
    const merged = mergeSprintFields(
      { sessions: { S1: { state: "running", units_done: 1, branch: "b" } } },
      { sessions: { S1: { units_done: 2 } } },
    );
    expect(merged["sessions"]).toEqual({ S1: { state: "running", units_done: 2, branch: "b" } });
  });

  it("takes the override as is when either side has no usable sessions", () => {
    expect(mergeSprintFields({}, { sessions: { S1: { state: "green" } } })["sessions"]).toEqual({
      S1: { state: "green" },
    });
    expect(mergeSprintFields({ sessions: { S1: 5 } }, { sessions: { S1: { a: 1 } } })).toEqual({
      sessions: { S1: { a: 1 } },
    });
    expect(mergeSprintFields({ sessions: { S1: {} }, a: 1 }, { a: 2 })).toEqual({
      sessions: { S1: {} },
      a: 2,
    });
  });
});

describe("mergeSprintStatus", () => {
  it("keeps S0 and S0b when a later write names only S0c", async () => {
    const base = { sprint: "0", name: "n", branch: "b", state: "running" };
    await mergeSprintStatus(stateDir, {
      ...base,
      sessions: { S0: { state: "green" }, S0b: { state: "not-started" } },
    });
    const next = await mergeSprintStatus(stateDir, { sessions: { S0c: { state: "running" } } });
    expect(Object.keys(next.sessions ?? {}).sort()).toEqual(["S0", "S0b", "S0c"]);
    expect((await readJson(sprintStatusPath(stateDir)))["name"]).toBe("n");
  });

  it("loses no update across concurrent merges of distinct sessions", async () => {
    const base = { sprint: "0", name: "n", branch: "b", state: "running" };
    await mergeSprintStatus(stateDir, base);
    const ids = Array.from({ length: 12 }, (_, i) => `S${i}`);
    await Promise.all(
      ids.map((id) =>
        mergeSprintStatus(
          stateDir,
          { sessions: { [id]: { state: "running" } } },
          { lock: { pollMs: 1, waitMs: 60_000 } },
        ),
      ),
    );
    const sessions = (await readJson(sprintStatusPath(stateDir)))["sessions"] as object;
    expect(Object.keys(sessions).sort()).toEqual([...ids].sort());
  }, 90_000);
});

describe("mergeSessionStatus over an existing file", () => {
  const path = (): string => sessionStatusPath(stateDir, "S6");

  it.each([
    ["schema-invalid", '{"state":"done","updated_at":"x"}'],
    ["without updated_at", '{"state":"running","units_total":4}'],
  ])("merges over a file that is %s, validating only the result", async (_name, text) => {
    await writeFile(path(), text);
    const out = await mergeSessionStatus(stateDir, "S6", { state: "green" });
    expect(out.state).toBe("green");
    expect(out.updated_at).toMatch(/Z$/);
  });

  it.each([
    ["0 bytes", ""],
    ["truncated JSON", '{"state":"run'],
    ["a JSON array", "[]"],
    ["a JSON scalar", "null"],
  ])("refuses %s unless replace is set", async (_name, text) => {
    await writeFile(path(), text);
    await expect(mergeSessionStatus(stateDir, "S6", { state: "green" })).rejects.toMatchObject({
      kind: "invalid-json",
    });
    expect(await readFile(path(), "utf8")).toBe(text); // not touched
    const out = await mergeSessionStatus(stateDir, "S6", { state: "green" }, { replace: true });
    expect(out.state).toBe("green");
    expect((await readJson(path()))["state"]).toBe("green");
  });

  it("replace drops the old fields instead of merging", async () => {
    await writeFile(path(), '{"state":"running","units_total":4,"updated_at":"x"}');
    await mergeSessionStatus(stateDir, "S6", { state: "green" }, { replace: true });
    expect((await readJson(path()))["units_total"]).toBeUndefined();
  });

  it("merges a BOM-prefixed file", async () => {
    await writeFile(path(), "\uFEFF" + '{"state":"running","units_total":4}');
    const out = await mergeSessionStatus(stateDir, "S6", { units_done: 1 });
    expect(out).toMatchObject({ state: "running", units_total: 4, units_done: 1 });
  });

  // 15 writers queue on one lock; on a loaded Windows runner each locked merge (read, tmp write,
  // rename with EPERM retries) takes tens to hundreds of ms, so the default 5 s lock wait and 5 s
  // test timeout are too tight. Both get headroom; the assertion is unchanged.
  it("loses no update across concurrent merges of distinct keys", async () => {
    const keys = Array.from({ length: 15 }, (_, i) => `k${i}`);
    await mergeSessionStatus(stateDir, "S6", { state: "running" });
    // allSettled: cleanup must not start while a sibling merge is still in flight.
    const results = await Promise.allSettled(
      keys.map((key) =>
        mergeSessionStatus(stateDir, "S6", { [key]: 1 }, { lock: { pollMs: 1, waitMs: 60_000 } }),
      ),
    );
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    const file = await readJson(path());
    expect(keys.filter((k) => file[k] !== 1)).toEqual([]);
  }, 90_000);
});
