import { describe, expect, it } from "vitest";
import { isOurExeEntry } from "../src/install/exe.ts";
import { parentRefusal } from "../src/install/home-check.ts";

type St = { uid: number; mode: number };
const fsOf = (tree: Record<string, St>) => async (p: string) => tree[p];
const ME = 1000;

describe("review 2, finding 2: the parent of the probe home is owned by you or root", () => {
  it("refuses a parent owned by another user, even at mode 0755, when the home is missing", async () => {
    const stat = fsOf({ "/srv/x": { uid: 1001, mode: 0o755 } });
    expect(await parentRefusal("/srv/x/sd", ME, stat)).toMatch(/owned by another user/);
  });
  it("walks up past a missing parent to the first existing ancestor", async () => {
    const stat = fsOf({ "/srv": { uid: 1001, mode: 0o755 } });
    expect(await parentRefusal("/srv/x/y/sd", ME, stat)).toMatch(/\/srv .*owned by another user/);
  });
  it("accepts own and root-owned parents, and a missing chain", async () => {
    expect(
      await parentRefusal("/h/sd", ME, fsOf({ "/h": { uid: ME, mode: 0o755 } })),
    ).toBeUndefined();
    expect(
      await parentRefusal("/h/sd", ME, fsOf({ "/h": { uid: 0, mode: 0o755 } })),
    ).toBeUndefined();
    expect(await parentRefusal("/h/sd", ME, fsOf({}))).toBeUndefined();
  });
  it("refuses a group/world-writable parent unless sticky", async () => {
    expect(await parentRefusal("/h/sd", ME, fsOf({ "/h": { uid: ME, mode: 0o777 } }))).toMatch(
      /writable/,
    );
    expect(
      await parentRefusal("/tmp/sd", ME, fsOf({ "/tmp": { uid: 0, mode: 0o1777 } })),
    ).toBeUndefined();
  });
});

describe("review 2, finding 3: only placeOne's own temp names count as ours", () => {
  it("accepts the exes and the exact temp form", () => {
    for (const n of ["hook", "hook.exe", "statusline.exe", "subagents"]) {
      expect(isOurExeEntry(n)).toBe(true);
    }
    expect(isOurExeEntry(".hook.exe.4242.0a1b2c3d.tmp")).toBe(true);
    expect(isOurExeEntry(".subagents.1.abcdef01.tmp")).toBe(true);
  });
  it("rejects user files that merely end in tmp", () => {
    for (const n of [
      "report.tmp",
      "notes-tmp",
      "a.b.tmp",
      ".hook.1.abcd.tmp",
      ".other.1.abcdef01.tmp",
    ]) {
      expect(isOurExeEntry(n)).toBe(false);
    }
  });
});
