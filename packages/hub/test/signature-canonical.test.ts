// R2.4: canonicalJson was rewritten for speed; it must stay byte-identical to the original form.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { canonicalJson } from "../src/ingest/signature.ts";

function reference(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => reference(v ?? null)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(rec).sort()) {
      if (rec[k] === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${reference(rec[k])}`);
    }
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

describe("canonicalJson", () => {
  it("matches the reference implementation on edge values", () => {
    const cases: unknown[] = [
      null,
      'a"b\n ',
      0,
      -0,
      1e21,
      true,
      [],
      {},
      [undefined, null, 1, [undefined]],
      { b: 1, a: { d: undefined, c: [3, { z: 1, y: undefined }] }, 'k"q': "v" },
      { __proto__x: 1, "": 2, "10": 3, "9": 4 },
    ];
    for (const c of cases) expect(canonicalJson(c)).toBe(reference(c));
  });

  it("matches the reference implementation on every JSON fixture", () => {
    const root = path.resolve(import.meta.dirname, "../../contract/fixtures");
    let n = 0;
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.name === "raw") continue;
      for (const ent of readdirSync(path.join(root, dir.name), { withFileTypes: true })) {
        if (!ent.isFile()) continue;
        const f = ent.name;
        const text = readFileSync(path.join(root, dir.name, f), "utf8");
        const docs = f.endsWith(".json")
          ? [text]
          : f.endsWith(".jsonl")
            ? text.split("\n").filter((l) => l.trim() !== "")
            : [];
        for (const d of docs) {
          const v: unknown = JSON.parse(d);
          expect(canonicalJson(v)).toBe(reference(v));
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(20);
  });
});
