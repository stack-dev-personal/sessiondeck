import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findMisplacedFixtures, loadFixtures } from "./helpers";

describe("fixture layout guard", () => {
  it("finds no misplaced .json under the real fixtures directory", () => {
    expect(findMisplacedFixtures()).toEqual([]);
  });

  describe("detection (temporary directories)", () => {
    const roots: string[] = [];
    afterEach(() => {
      for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
    });
    function makeRoot(files: string[]): string {
      const root = mkdtempSync(join(tmpdir(), "sd-fixtures-"));
      roots.push(root);
      for (const rel of files) {
        const full = join(root, rel);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, "{}");
      }
      return root;
    }

    it("returns nothing for a missing root", () => {
      expect(findMisplacedFixtures(join(tmpdir(), "sd-does-not-exist-xyz"))).toEqual([]);
    });

    it("accepts <Event>/*.json and ignores raw/ and settings/", () => {
      const root = makeRoot(["Stop/a.json", "raw/Stop/b.json", "settings/c.json", "note.txt"]);
      expect(findMisplacedFixtures(root)).toEqual([]);
      expect(loadFixtures(root).map((f) => `${f.dir}/${f.file}`)).toEqual(["Stop/a.json"]);
    });

    it("flags a .json directly in fixtures/", () => {
      const root = makeRoot(["Stop.json"]);
      expect(findMisplacedFixtures(root)).toEqual(["Stop.json"]);
      expect(loadFixtures(root)).toEqual([]);
    });

    it("flags a .json nested below <Event>/", () => {
      const root = makeRoot(["Stop/deep/er/a.json"]);
      expect(findMisplacedFixtures(root)).toEqual(["Stop/deep/er/a.json"]);
      expect(loadFixtures(root)).toEqual([]);
    });
  });
});
