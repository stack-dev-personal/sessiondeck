import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

const CALL =
  /(?:\b[dD]b|database|\bthis)\.(?:stmt|prepare|exec|pragma)\(\s*|(?<![.\w])(?:stmt)\(\s*/g;
const PLAIN_LITERAL = /^(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`$\\]*`)\s*[,)]/;

/** Returns offending call sites: first argument must be a single plain string literal. */
export function findViolations(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CALL)) {
    const rest = text.slice(m.index + m[0].length);
    if (/^\w+\s*:/.test(rest)) continue; // method signature, e.g. stmt(sql: string)
    if (!PLAIN_LITERAL.test(rest)) out.push(`${m[0]}${rest.slice(0, 40)}`);
  }
  return out;
}

describe("sql hygiene", () => {
  it("every stmt/prepare/exec/pragma first argument in src is a plain string literal", () => {
    const src = path.join(import.meta.dirname, "..", "src");
    for (const f of walk(src).filter((p) => p.endsWith(".ts"))) {
      const bad = findViolations(readFileSync(f, "utf8")).filter(
        // migrations are executed as a vetted constant, not built from input
        (v) => !(f.endsWith("store.ts") && /exec\(m\.sql\)|prepare\(sql\)/.test(v)),
      );
      expect(bad, f).toEqual([]);
    }
  });

  it("guard catches interpolation and concatenation", () => {
    expect(findViolations("this.stmt(`SELECT * FROM t WHERE a = '${x}'`)")).toHaveLength(1);
    expect(findViolations('this.stmt("SELECT " + col)')).toHaveLength(1);
    expect(findViolations('db.prepare("SELECT " + col + " FROM t")')).toHaveLength(1);
    expect(findViolations("db.exec(sqlVar)")).toHaveLength(1);
    expect(findViolations('this.stmt("SELECT 1")')).toEqual([]);
    expect(findViolations("this.stmt(`SELECT 1\n FROM t`)")).toEqual([]);
  });
});
