// Transcript line redactor (R4.7, A14). Runs in the daemon tailer on every line before it is
// enqueued. Lines are JSON: the line is parsed, every string value and object key is redacted, and
// the line is re-serialized only if something changed (unchanged lines stay byte-identical). A line
// that does not parse is redacted as raw text and still shipped. Redacted spans become
// `[redacted:<rule>]`.
import vm from "node:vm";
import {
  type CompiledRedactionConfig,
  USER_OVERLAP,
  USER_WINDOW,
  compileRedactionConfig,
} from "./config.ts";
import {
  BUILTIN_RULES,
  type Groups,
  type Rule,
  STRUCT_HINT,
  isSecretKeyName,
  PLACEHOLDER_LOOKAHEAD,
  PATTERN_HINTS,
} from "./rules.ts";

export interface Redactor {
  /** Returns the line with secrets replaced. Never throws; never returns the unredacted line on failure. */
  redactLine(line: string): string;
  readonly enabled: boolean;
}

export interface RedactorSetup {
  redactor: Redactor;
  /** Set when the user config was rejected and built-ins alone are in force. */
  error?: string;
}

const MAX_DEPTH = 64;
class TooDeep extends Error {}
const FAILED_MARKER = JSON.stringify({ type: "sessiondeck_marker", reason: "redaction_failed" });
/** Matches at 0 only for a value that is NOT a placeholder (the pattern is a negative lookahead). */
const REAL_VALUE = new RegExp(`^${PLACEHOLDER_LOOKAHEAD}`);

/**
 * Per-line time budget when user patterns are configured. The built-in rules take well under 1 s on
 * 1 MB; a user pattern that backtracks catastrophically is cut off at this deadline and the line
 * becomes the redaction_failed marker (nothing unredacted ships).
 */
export const LINE_BUDGET_MS = 1000;
const vmCtx = vm.createContext({ fn: undefined as (() => string) | undefined });
const vmScript = new vm.Script("fn()");
/** Runs `f` under a watchdog (one per call, about 0.2 ms); throws ERR_SCRIPT_EXECUTION_TIMEOUT past `ms`. */
function bounded(f: () => string, ms: number): string {
  (vmCtx as { fn?: () => string }).fn = f;
  try {
    return vmScript.runInContext(vmCtx, { timeout: ms }) as string;
  } finally {
    (vmCtx as { fn?: () => string }).fn = undefined;
  }
}

const IDENTITY: Redactor = { redactLine: (l) => l, enabled: false };

/** Redactor for an already validated config. */
export function createRedactor(cfg?: CompiledRedactionConfig): Redactor {
  if (cfg && !cfg.enabled) return IDENTITY;
  const rules: Rule[] = BUILTIN_RULES.filter((r) => !cfg?.disableRules.has(r.name));
  const deny = cfg?.deny ?? [];
  const allow = cfg?.allow ?? [];
  // The structural key walk is not a rule and cannot be disabled by name, so its words are always
  // part of the gate.
  const lineHint = new RegExp(
    [...rules.flatMap((r) => (r.hint ? [r.hint.source] : [])), STRUCT_HINT.source].join("|"),
    "i",
  );
  const alwaysScan = deny.length > 0 || rules.some((r) => !r.hint);
  // Allow patterns are tested against the secret span only, never the key prefix around it.
  const allowed = (x: string): boolean => allow.some((a) => a.test(x));

  /**
   * `depth` > 0 is a rescan of a span whose first match was rejected by `check`: the rejected value
   * (`a(b)password=X`) gives its span back so a later match can start inside it. Two levels at most,
   * so the extra work stays a small constant multiple of the line.
   */
  const applyRule = (text: string, rule: Rule, depth = 0): string => {
    if (rule.hint && !rule.hint.test(text)) return text;
    for (const re of rule.patterns) {
      const gate = PATTERN_HINTS.get(re);
      if (gate && !gate.test(text)) continue;
      text = text.replace(re, (...args: unknown[]) => {
        const m = args[0] as string;
        const last = args[args.length - 1];
        const gr = (typeof last === "object" && last !== null ? last : {}) as Groups;
        let sec = gr["sec"] ?? gr["sec2"];
        let tail = "";
        if (rule.trim && sec !== undefined && gr["sec"] === undefined) {
          const t = rule.trim(sec);
          if (t.length < 3) return m; // what is left of the value is too short to be one
          tail = sec.slice(t.length);
          sec = t;
        }
        const secret = sec ?? m;
        if (rule.check && !rule.check(secret, gr)) {
          if (depth >= 2 || sec === undefined || sec.length < 8) return m;
          const at = m.indexOf(sec, (gr["pre"] ?? "").length);
          if (at < 0) return m;
          return m.slice(0, at) + applyRule(sec, rule, depth + 1) + m.slice(at + sec.length);
        }
        if (allow.length > 0 && allowed(secret)) return m;
        const mark = `[redacted:${rule.name}]`;
        if (sec === undefined && gr["pre"] === undefined) return mark;
        const q = gr["q"] ?? "";
        return `${gr["pre"] ?? ""}${q}${mark}${q}${tail}`;
      });
    }
    return text;
  };

  /**
   * User patterns run on windows of USER_WINDOW characters that overlap by USER_OVERLAP, so a match
   * straddling a boundary is still found and a catastrophic pattern is bounded by the window.
   */
  const applyDeny = (text: string): string => {
    for (const d of deny) {
      const mark = `[redacted:${d.name}]`;
      let out = "";
      let done = 0; // text[0, done) is already in `out`
      for (let i = 0; i < text.length; i += USER_WINDOW) {
        const win = text.slice(i, i + USER_WINDOW + USER_OVERLAP);
        for (const m of win.matchAll(d.re)) {
          const start = i + m.index;
          if (start >= i + USER_WINDOW && i + USER_WINDOW < text.length) break; // next window owns it
          if (start < done) continue;
          out += text.slice(done, start) + (allowed(m[0]) ? m[0] : mark);
          done = start + m[0].length;
        }
      }
      text = out + text.slice(done);
    }
    return text;
  };

  const redactText = (text: string): string => {
    if (text.length < 6 && deny.length === 0) return text;
    for (const r of rules) text = applyRule(text, r);
    return deny.length > 0 ? applyDeny(text) : text;
  };

  /** Walks a parsed value; `ch.n` counts changes so unchanged lines are not re-serialized. */
  const walk = (v: unknown, ch: { n: number }, depth: number): unknown => {
    if (typeof v === "string") {
      const r = redactText(v);
      if (r !== v) ch.n += 1;
      return r;
    }
    if (typeof v !== "object" || v === null) return v;
    if (depth > MAX_DEPTH) throw new TooDeep();
    if (Array.isArray(v)) {
      let out: unknown[] | undefined;
      for (let i = 0; i < v.length; i++) {
        const n = walk(v[i], ch, depth + 1);
        if (n !== v[i]) (out ??= v.slice())[i] = n;
      }
      return out ?? v;
    }
    const o = v as Record<string, unknown>;
    let out: Record<string, unknown> | undefined;
    for (const k of Object.keys(o)) {
      const val = o[k];
      const nk = redactText(k);
      let nv: unknown;
      if (
        typeof val === "string" &&
        val.length >= 4 &&
        !val.startsWith("[redacted:") &&
        isSecretKeyName(k) &&
        REAL_VALUE.test(val) &&
        !(allow.length > 0 && allowed(val))
      ) {
        nv = "[redacted:secret-key]";
        ch.n += 1;
      } else {
        nv = walk(val, ch, depth + 1);
      }
      if (nk !== k) ch.n += 1;
      if (nk === k && nv === val && out === undefined) continue;
      if (out === undefined) {
        out = Object.create(null) as Record<string, unknown>; // a "__proto__" key stays an own key
        for (const k2 of Object.keys(o)) {
          if (k2 === k) break;
          out[k2] = o[k2];
        }
      }
      // Two keys that redact to the same text must not overwrite each other.
      let key = nk;
      for (let i = 2; key in out; i++) key = `${nk}~${i}`;
      out[key] = nv;
    }
    return out ?? v;
  };

  /**
   * Unparseable line: redact the raw text. A second pass over a copy with the escapes undone
   * catches keys hidden by `\"`; that copy is only returned when it found something the first
   * pass missed, so unrelated escapes are not mangled.
   */
  const rawFallback = (line: string): string => {
    const direct = redactText(line);
    const plain = direct.replace(/\\"/g, '"').replace(/\\[nrt]/g, " ");
    const viaPlain = redactText(plain);
    return viaPlain !== plain ? viaPlain : direct;
  };

  const redactLine = (line: string): string => {
    try {
      if (!alwaysScan && !line.includes("\\u") && !lineHint.test(line)) return line;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return rawFallback(line);
      }
      const ch = { n: 0 };
      let r: unknown;
      try {
        r = walk(parsed, ch, 0);
      } catch (e) {
        if (e instanceof TooDeep) return rawFallback(line);
        throw e;
      }
      return ch.n === 0 ? line : JSON.stringify(r);
    } catch {
      return FAILED_MARKER;
    }
  };
  if (deny.length === 0 && allow.length === 0) return { enabled: true, redactLine };
  // User patterns can backtrack without bound: run each line under a deadline.
  return {
    enabled: true,
    redactLine(line: string): string {
      try {
        return bounded(() => redactLine(line), LINE_BUDGET_MS);
      } catch {
        return FAILED_MARKER;
      }
    },
  };
}

/**
 * Builds the redactor from the raw probe.json `redaction` value. A rejected config yields the
 * built-in rules alone (enabled) plus an error string for the caller to log.
 */
export function redactorFromConfig(raw: unknown): RedactorSetup {
  const c = compileRedactionConfig(raw);
  if (c.ok) return { redactor: createRedactor(c.value) };
  return { redactor: createRedactor(), error: c.error };
}
