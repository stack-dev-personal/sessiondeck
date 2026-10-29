// probe.json `redaction` section: validation and compilation (R4.7).
//
//   "redaction": {
//     "enabled": true,                       // default; only an explicit false turns redaction off
//     "deny":  [{ "name": "corp-id", "pattern": "CORP-[0-9]{8}", "flags": "i" }],
//     "allow": ["^ghp_EXAMPLE"],             // detected spans that match are left alone
//     "disableRules": ["service-key"]        // built-in rule names
//   }
//
// Any error here makes the loader fall back to the built-in rules only (enabled, nothing allowed,
// nothing disabled): a bad user rule never results in unredacted shipping.
//
// ReDoS: built-in patterns are linear. User patterns are arbitrary regexes; we reject the common
// nested-quantifier shape and patterns that match the empty string, cap pattern length, and run
// deny patterns over overlapping windows of USER_WINDOW (+ USER_OVERLAP) characters.
// The static checks (nested quantifier, quantified alternation, more than one unbounded or ranged
// quantifier, many optional items) are a first line, not a proof. The protection is the runtime
// bound in redactor.ts: with any deny or allow pattern configured, each line is redacted under a
// vm timeout (LINE_BUDGET_MS) and a line that exceeds it becomes the redaction_failed marker.
import { BUILTIN_RULE_NAMES } from "./rules.ts";

export interface RedactionConfig {
  enabled?: boolean;
  deny?: { name: string; pattern: string; flags?: string }[];
  allow?: string[];
  disableRules?: string[];
}

export interface CompiledRedactionConfig {
  enabled: boolean;
  deny: { name: string; re: RegExp }[];
  allow: RegExp[];
  disableRules: Set<string>;
}

export const USER_WINDOW = 4096;
/** Windows overlap by this much, so a match up to this long is never split by a boundary. */
export const USER_OVERLAP = 512;
const MAX_PATTERN = 500;
const MAX_ENTRIES = 100;
const FLAGS = /^[imsu]*$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
/**
 * Is a group that holds an unbounded or ranged quantifier itself repeated: `(a+)+`, `((a+))*`,
 * `(?:\w+){4}`, `(a{1,99}){1,99}`? An exact `{n}` inside is bounded and allowed; any outer
 * quantifier except `?` on such a group is rejected. A small scanner, not a regex, so nesting works.
 */
function hasNestedQuantifier(p: string): boolean {
  const stack: boolean[] = []; // per open group: does it hold a variable quantifier
  let cur = false;
  let i = 0;
  // Reads the quantifier at i: "var" (+ * {n,} {n,m}), "exact" ({n}), "opt" (?), or "none".
  const quant = (): "var" | "exact" | "opt" | "none" => {
    const c = p[i];
    if (c === "+" || c === "*") {
      i += 1;
      if (p[i] === "?" || p[i] === "+") i += 1;
      return "var";
    }
    if (c === "?") {
      i += 1;
      if (p[i] === "?") i += 1;
      return "opt";
    }
    const m = /^\{(\d+)(,?)(\d*)\}/.exec(p.slice(i, i + 24));
    if (m) {
      i += m[0].length;
      if (p[i] === "?") i += 1;
      return m[2] === "" ? "exact" : "var";
    }
    return "none";
  };
  while (i < p.length) {
    const c = p[i]!;
    if (c === "\\") {
      i += 2;
    } else if (c === "[") {
      i += 1;
      while (i < p.length && p[i] !== "]") i += p[i] === "\\" ? 2 : 1;
      i += 1;
    } else if (c === "(") {
      stack.push(cur);
      cur = false;
      i += 1;
      continue;
    } else if (c === ")") {
      i += 1;
      const inner: boolean = cur;
      cur = stack.pop() ?? false;
      const q = quant();
      if (inner && (q === "var" || q === "exact")) return true;
      cur = cur || inner || q === "var";
      continue;
    } else {
      i += 1;
    }
    // An inner `?` makes the group variable too: `(?:a?){40}b` is exponential.
    const q = quant();
    if (q === "var" || q === "opt") cur = true;
  }
  return false;
}
/** A quantified group with alternation: `(a|aa)+`, `(a|a)*`, `(a|b){9}`. Write a character class instead. */
const ALT_REPEATED = /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+(?:,\d*)?\})/;
/** At most one unbounded (or ranged to 100+) quantifier: more is polynomial, n^k per start. */
const MAX_UNBOUNDED = 1;
/** Optional atoms: `a?a?a?...a{n}` backtracks exponentially, so only a few are allowed. */
const MAX_OPTIONAL = 6;
function strip(p: string): string {
  return p.replace(/\\./g, "").replace(/\[[^\]]*\]/g, "");
}
function unboundedCount(p: string): number {
  const bare = strip(p);
  const wide = (bare.match(/\{\d*,(\d*)\}/g) ?? []).filter((q) => {
    const hi = /,(\d*)\}/.exec(q)?.[1] ?? "";
    return hi === "" || Number(hi) >= 100;
  }).length;
  return (bare.match(/[+*]/g) ?? []).length + wide;
}
/** Ranged quantifiers `{n,m}` with m > n (or open): each adds a factor to the backtracking, so cap them. */
const MAX_RANGES = 2;
function rangeCount(p: string): number {
  return (strip(p).match(/\{\d*,\d*\}/g) ?? []).filter((q) => {
    const m = /^\{(\d*),(\d*)\}$/.exec(q);
    return m !== null && (m[2] === "" || Number(m[2]) > Number(m[1] || "0"));
  }).length;
}
function optionalCount(p: string): number {
  return (strip(p).match(/(?<![(+*?}])\?/g) ?? []).length;
}

export type Compiled = { ok: true; value: CompiledRedactionConfig } | { ok: false; error: string };

function compile(pattern: unknown, flags: unknown, what: string): RegExp | string {
  if (typeof pattern !== "string" || pattern === "")
    return `${what}: pattern must be a non-empty string`;
  if (pattern.length > MAX_PATTERN) return `${what}: pattern longer than ${MAX_PATTERN} characters`;
  if (flags !== undefined && (typeof flags !== "string" || !FLAGS.test(flags))) {
    return `${what}: flags may only contain i, m, s, u`;
  }
  if (hasNestedQuantifier(pattern)) {
    return `${what}: nested quantifier (catastrophic backtracking risk); rewrite the pattern`;
  }
  if (ALT_REPEATED.test(pattern)) {
    return `${what}: repeated group with alternation (catastrophic backtracking risk); use a character class`;
  }
  if (unboundedCount(pattern) > MAX_UNBOUNDED) {
    return `${what}: more than ${MAX_UNBOUNDED} unbounded quantifier (polynomial backtracking risk); use bounded ones such as {1,64}`;
  }
  if (rangeCount(pattern) > MAX_RANGES) {
    return `${what}: more than ${MAX_RANGES} ranged quantifiers {n,m} (polynomial backtracking risk); use exact counts such as {8}`;
  }
  if (optionalCount(pattern) > MAX_OPTIONAL) {
    return `${what}: more than ${MAX_OPTIONAL} optional items (exponential backtracking risk)`;
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, `g${typeof flags === "string" ? flags : ""}`);
  } catch {
    // The engine's message quotes the pattern, which may be a literal secret: name the entry only.
    return `${what}: invalid regular expression`;
  }
  if (new RegExp(re.source, re.flags).test("")) return `${what}: pattern matches the empty string`;
  return re;
}

/** Validates the raw `redaction` value from probe.json. `undefined` means the defaults. */
export function compileRedactionConfig(raw: unknown): Compiled {
  const out: CompiledRedactionConfig = {
    enabled: true,
    deny: [],
    allow: [],
    disableRules: new Set(),
  };
  if (raw === undefined) return { ok: true, value: out };
  const bad = (error: string): Compiled => ({ ok: false, error: `redaction: ${error}` });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return bad("must be an object");
  }
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (!["enabled", "deny", "allow", "disableRules"].includes(k)) return bad(`unknown key "${k}"`);
  }
  if (r["enabled"] !== undefined && typeof r["enabled"] !== "boolean") {
    return bad("enabled must be true or false");
  }
  const enabled = r["enabled"] !== false;
  for (const key of ["deny", "allow", "disableRules"] as const) {
    const v = r[key];
    if (v === undefined) continue;
    if (!Array.isArray(v)) return bad(`${key} must be an array`);
    if (v.length > MAX_ENTRIES) return bad(`${key} has more than ${MAX_ENTRIES} entries`);
  }
  const names = new Set<string>();
  for (const [i, d] of ((r["deny"] as unknown[] | undefined) ?? []).entries()) {
    const what = `deny[${i}]`;
    if (typeof d !== "object" || d === null) return bad(`${what} must be an object`);
    const e = d as Record<string, unknown>;
    const name = e["name"];
    if (typeof name !== "string" || !NAME.test(name)) {
      return bad(`${what}.name must be 1-40 letters, digits, '_' or '-'`);
    }
    if (BUILTIN_RULE_NAMES.includes(name) || names.has(name)) {
      return bad(`${what}.name "${name}" is already used`);
    }
    names.add(name);
    const re = compile(e["pattern"], e["flags"], `${what} (${name})`);
    if (typeof re === "string") return bad(re);
    out.deny.push({ name, re });
  }
  for (const [i, a] of ((r["allow"] as unknown[] | undefined) ?? []).entries()) {
    const re = compile(a, undefined, `allow[${i}]`);
    if (typeof re === "string") return bad(re);
    out.allow.push(new RegExp(re.source, re.flags.replace("g", "")));
  }
  for (const [i, n] of ((r["disableRules"] as unknown[] | undefined) ?? []).entries()) {
    if (typeof n !== "string" || !BUILTIN_RULE_NAMES.includes(n)) {
      return bad(`disableRules[${i}] is not a built-in rule (${BUILTIN_RULE_NAMES.join(", ")})`);
    }
    out.disableRules.add(n);
  }
  out.enabled = enabled;
  return { ok: true, value: out };
}
