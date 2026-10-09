import { describe, expect, it } from "vitest";
import {
  REDACTED,
  SECRET_BODY_MIN_CHARS,
  SECRET_KEY_NAMES,
  SECRET_SCAN_MAX_DEPTH,
  SECRET_VALUE_PREFIXES,
  StateFileError,
  assertNoSecrets,
  findSecretPath,
  hasSecretShape,
  scrubSecrets,
} from "../src/state-file";

// Credential-looking strings are assembled at run time so no literal in the repo resembles one.
const FILLER = "x".repeat(24);
const tokenFor = (prefix: string): string => `${prefix}${FILLER}`;

describe("secrets guard", () => {
  it("lists every shape the task names", () => {
    expect([...SECRET_VALUE_PREFIXES]).toEqual([
      "sk-" + "ant-",
      "gh" + "p_",
      "gh" + "o_",
      "gh" + "u_",
      "gh" + "s_",
      "gh" + "r_",
      "github" + "_pat_",
    ]);
  });

  it.each([...SECRET_VALUE_PREFIXES])("refuses a value starting with %s, at depth", (prefix) => {
    const value = { sessions: { S1: { notes: ["fine", tokenFor(prefix)] } } };
    expect(findSecretPath(value)).toBe("$.sessions.S1.notes[1]");
    const attempt = (): void => assertNoSecrets(value);
    expect(attempt).toThrow(StateFileError);
    expect(attempt).toThrow("$.sessions.S1.notes[1]");
    expect(attempt).not.toThrow(FILLER);
  });

  it("refuses a token embedded after a space", () => {
    expect(findSecretPath({ note: `Bearer ${tokenFor("gh" + "p_")}` })).toBe("$.note");
  });

  it("does not trip on a prefix in the middle of a word", () => {
    expect(findSecretPath({ note: "highs_and_lows, tasks-ant-hill" })).toBeUndefined();
  });

  it.each([...SECRET_KEY_NAMES, "gh_token"])("refuses the key %s at depth", (key) => {
    const value = { env: { [key]: "set" } };
    expect(findSecretPath(value)).toBe(`$.env.${key}`);
    expect(() => assertNoSecrets(value)).toThrow(`$.env.${key}`);
  });

  it("refuses a credential used as a key without echoing it", () => {
    const key = tokenFor("gh" + "p_");
    const attempt = (): void => assertNoSecrets({ [key]: 1 });
    expect(attempt).toThrow(`$["<key>"]`);
    expect(attempt).not.toThrow(FILLER);
  });

  it("quotes keys that are not identifiers", () => {
    expect(findSecretPath({ "a-b": { c: tokenFor("sk-" + "ant-") } })).toBe('$["a-b"].c');
  });

  it("passes an ordinary status", () => {
    const status = {
      sprint: "1",
      state: "running",
      sessions: { S1: { state: "green", pr: 4, branch: "p1/probe-hook" } },
      ok: true,
      none: null,
    };
    expect(findSecretPath(status)).toBeUndefined();
    expect(() => assertNoSecrets(status)).not.toThrow();
  });

  it("stops at the depth limit instead of overflowing", () => {
    let nested: unknown = "leaf";
    for (let i = 0; i <= SECRET_SCAN_MAX_DEPTH + 1; i += 1) nested = { n: nested };
    expect(findSecretPath(nested)).toMatch(/nested too deeply/);
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(findSecretPath(cyclic)).toMatch(/nested too deeply/);
  });
});

describe("secrets guard: bare prefixes and added key names", () => {
  it("accepts a sentence that only names the prefixes", () => {
    const note = "U4 secrets guard (sk-" + "ant-, gh" + "p_ prefixes)";
    expect(findSecretPath({ current_unit: note })).toBeUndefined();
  });

  it("still refuses a prefix followed by a token body", () => {
    expect(findSecretPath({ current_unit: `see ${tokenFor("sk-" + "ant-")}` })).toBe(
      "$.current_unit",
    );
    const shortest = "gh" + "p_" + "x".repeat(SECRET_BODY_MIN_CHARS);
    expect(findSecretPath({ n: shortest })).toBe("$.n");
    expect(findSecretPath({ n: shortest.slice(0, -1) })).toBeUndefined();
  });

  it.each(["GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"])("refuses the key %s", (key) => {
    expect(SECRET_KEY_NAMES).toContain(key);
    expect(findSecretPath({ [key]: "abc" })).toBe(`$.${key}`);
  });

  it("scrubSecrets replaces every credential-shaped run and keeps the rest", () => {
    const text = `a ${tokenFor("gh" + "p_")} b ${tokenFor("sk-" + "ant-")} c`;
    expect(scrubSecrets(text)).toBe(`a ${REDACTED} b ${REDACTED} c`);
    expect(scrubSecrets("nothing here")).toBe("nothing here");
    expect(hasSecretShape(tokenFor("gh" + "s_"))).toBe(true);
  });
});
