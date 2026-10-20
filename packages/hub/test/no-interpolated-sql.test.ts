import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

const CALL = /\.(?:stmt|prepare|exec|pragma)\(\s*|(?<![.\w])stmt\(\s*/g;
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

/**
 * Blanks the two vetted dynamic call sites, each only inside its own function body:
 * the cached prepare in stmt() (callers pass literals) and the migration constant in migrate().
 */
export function withoutVetted(text: string): string {
  const vetted: [string, string][] = [
    ["private stmt(sql: string)", "s = this.db.prepare(sql);"],
    ["migrate(): number[] {", "this.db.exec(m.sql);"],
  ];
  let out = text;
  for (const [sig, line] of vetted) {
    const start = out.indexOf(sig);
    const end = out.indexOf("\n  }\n", start);
    if (start < 0 || end < 0) continue;
    out = out.slice(0, start) + out.slice(start, end).replace(line, "") + out.slice(end);
  }
  return out;
}

describe("sql hygiene", () => {
  it("every stmt/prepare/exec/pragma first argument in src is a plain string literal", () => {
    const src = path.join(import.meta.dirname, "..", "src");
    for (const f of walk(src).filter((p) => p.endsWith(".ts"))) {
      const text = readFileSync(f, "utf8");
      const bad = findViolations(f.endsWith("store.ts") ? withoutVetted(text) : text);
      expect(bad, f).toEqual([]);
    }
  });

  it("vetted exemption is location-bound: prepare(sql) in a new store.ts function is flagged", () => {
    const real = readFileSync(
      path.join(import.meta.dirname, "..", "src", "db", "store.ts"),
      "utf8",
    );
    expect(findViolations(withoutVetted(real))).toEqual([]);
    const evil = real.replace(
      "  close(): void {",
      "  evil(x: string) {\n    const sql = `SELECT * FROM t WHERE a='${x}'`;\n    return this.db.prepare(sql);\n  }\n\n  close(): void {",
    );
    expect(findViolations(withoutVetted(evil))).toHaveLength(1);
    const evil2 = real.replace(
      "  close(): void {",
      "  evil2(id: string) {\n    const conn = this.db;\n    conn.exec(`DELETE FROM t WHERE id=${id}`);\n  }\n\n  close(): void {",
    );
    expect(findViolations(withoutVetted(evil2))).toHaveLength(1);
  });

  it("guard catches interpolation and concatenation", () => {
    expect(findViolations("this.stmt(`SELECT * FROM t WHERE a = '${x}'`)")).toHaveLength(1);
    expect(findViolations('this.stmt("SELECT " + col)')).toHaveLength(1);
    expect(findViolations('db.prepare("SELECT " + col + " FROM t")')).toHaveLength(1);
    expect(findViolations("db.exec(sqlVar)")).toHaveLength(1);
    expect(
      findViolations("const conn = this.db; conn.exec(`DELETE FROM t WHERE id=${id}`)"),
    ).toHaveLength(1);
    expect(findViolations("this.db.prepare(sql)")).toHaveLength(1);
    expect(findViolations('this.stmt("SELECT 1")')).toEqual([]);
    expect(findViolations("this.stmt(`SELECT 1\n FROM t`)")).toEqual([]);
  });
});
