/**
 * Layout spec (R6.1): a tree of splits with typed leaf panes. Pure functions only: validate,
 * parse, serialize, normalize and small read helpers. The tree is plain JSON so it round-trips
 * through localStorage now and the hub's `layouts` table later without loss.
 */

export const PANE_TYPES = ["board", "session", "project", "metrics"] as const;
export type PaneType = (typeof PANE_TYPES)[number];

export interface Pane {
  kind: "pane";
  id: string;
  type: PaneType;
  sessionId?: string;
  projectDir?: string;
  compact?: boolean;
}

export interface Split {
  kind: "split";
  dir: "row" | "column";
  ratios: number[];
  children: Node[];
}

export type Node = Split | Pane;

export interface LayoutSpec {
  version: 1;
  id: string;
  name: string;
  root: Node;
}

/** Caps keep a hostile or corrupt spec from building an enormous DOM. */
export const MAX_DEPTH = 6;
export const MAX_PANES = 16;
export const MAX_CHILDREN = 12;
/** Ratios must sum to 1 within this; normalize() makes the sum exact. */
export const RATIO_SUM_TOLERANCE = 1e-3;
export const MIN_RATIO = 0.01;

export type ParseResult = { ok: true; spec: LayoutSpec } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown, max = 256): v is string => typeof v === "string" && v.length <= max;

class Invalid extends Error {}
const fail = (msg: string): never => {
  throw new Invalid(msg);
};

function readNode(v: unknown, depth: number, seen: Set<string>): Node {
  if (!isObj(v)) return fail("node is not an object");
  if (depth > MAX_DEPTH) return fail(`tree deeper than ${MAX_DEPTH}`);
  if (v["kind"] === "pane") {
    const { id, type, sessionId, projectDir, compact } = v;
    if (!str(id) || id === "") return fail("pane id must be a non-empty string");
    if (id.includes(":")) return fail("pane id must not contain ':' (reserved for splits)");
    if (seen.has(id)) return fail(`duplicate pane id ${id}`);
    seen.add(id);
    if (typeof type !== "string" || !(PANE_TYPES as readonly string[]).includes(type))
      return fail(`unknown pane type ${String(type)}`);
    const pane: Pane = { kind: "pane", id, type: type as PaneType };
    if (sessionId !== undefined) {
      if (!str(sessionId)) return fail("sessionId must be a string");
      pane.sessionId = sessionId;
    }
    if (projectDir !== undefined) {
      if (!str(projectDir, 1024)) return fail("projectDir must be a string");
      pane.projectDir = projectDir;
    }
    if (compact !== undefined) {
      if (typeof compact !== "boolean") return fail("compact must be a boolean");
      pane.compact = compact;
    }
    if (seen.size > MAX_PANES) return fail(`more than ${MAX_PANES} panes`);
    return pane;
  }
  if (v["kind"] === "split") {
    const { dir, ratios, children } = v;
    if (dir !== "row" && dir !== "column") return fail("split dir must be row or column");
    if (!Array.isArray(children) || children.length < 2 || children.length > MAX_CHILDREN)
      return fail(`split needs 2 to ${MAX_CHILDREN} children`);
    if (!Array.isArray(ratios) || ratios.length !== children.length)
      return fail("ratios length must equal children length");
    let sum = 0;
    for (const r of ratios) {
      if (typeof r !== "number" || !Number.isFinite(r) || r < MIN_RATIO || r > 1)
        return fail("ratio out of range");
      sum += r;
    }
    if (Math.abs(sum - 1) > RATIO_SUM_TOLERANCE) return fail("ratios must sum to 1");
    return {
      kind: "split",
      dir,
      ratios: ratios as number[],
      children: children.map((c) => readNode(c, depth + 1, seen)),
    };
  }
  return fail("node kind must be split or pane");
}

/** Validates unknown input and returns a fresh typed spec. Never throws. Ratios are kept as given. */
export function validate(input: unknown): ParseResult {
  try {
    if (!isObj(input)) return { ok: false, error: "spec is not an object" };
    if (input["version"] !== 1) return { ok: false, error: "unsupported version" };
    const { id, name } = input;
    if (!str(id) || id === "") return { ok: false, error: "id must be a non-empty string" };
    if (!str(name)) return { ok: false, error: "name must be a string" };
    const root = readNode(input["root"], 0, new Set());
    return { ok: true, spec: { version: 1, id, name, root } };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: e.message };
    throw e;
  }
}

/** Parses JSON text (or an already parsed value) into a spec. */
export function parse(input: string | unknown): ParseResult {
  if (typeof input !== "string") return validate(input);
  try {
    return validate(JSON.parse(input));
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
}

/** Deterministic JSON: fixed key order, so equal specs serialize to equal text. */
export function serialize(spec: LayoutSpec): string {
  const node = (n: Node): unknown => {
    if (n.kind === "split")
      return { kind: "split", dir: n.dir, ratios: n.ratios, children: n.children.map(node) };
    const o: Record<string, unknown> = { kind: "pane", id: n.id, type: n.type };
    if (n.sessionId !== undefined) o["sessionId"] = n.sessionId;
    if (n.projectDir !== undefined) o["projectDir"] = n.projectDir;
    if (n.compact !== undefined) o["compact"] = n.compact;
    return o;
  };
  return JSON.stringify({ version: 1, id: spec.id, name: spec.name, root: node(spec.root) });
}

/** Rescales ratios so each split sums to exactly 1 (within float error). Pure; panes untouched. */
export function normalize(spec: LayoutSpec): LayoutSpec {
  const go = (n: Node): Node => {
    if (n.kind === "pane") return n;
    const sum = n.ratios.reduce((a, b) => a + b, 0);
    return { ...n, ratios: n.ratios.map((r) => r / sum), children: n.children.map(go) };
  };
  return { ...spec, root: go(spec.root) };
}

/** Panes in reading order (depth first, left to right / top to bottom). */
export function panesOf(spec: LayoutSpec): Pane[] {
  const out: Pane[] = [];
  const go = (n: Node) => {
    if (n.kind === "pane") out.push(n);
    else n.children.forEach(go);
  };
  go(spec.root);
  return out;
}

/** Child-index path from the root to the node, or null. Used as the split's stable id. */
export function pathOfPane(spec: LayoutSpec, paneId: string): number[] | null {
  const go = (n: Node, path: number[]): number[] | null => {
    if (n.kind === "pane") return n.id === paneId ? path : null;
    for (let i = 0; i < n.children.length; i++) {
      const r = go(n.children[i]!, [...path, i]);
      if (r) return r;
    }
    return null;
  };
  return go(spec.root, []);
}

export const pathKey = (path: readonly number[]): string => (path.length ? path.join(".") : "root");
