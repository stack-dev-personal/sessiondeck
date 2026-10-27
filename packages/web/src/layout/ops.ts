/**
 * Pure reducers on a LayoutSpec. The layout store only calls these, so later units (compact-all
 * snapshot and restore, pane assignment, saved layouts) add reducers here without touching React.
 * Every reducer returns a new spec and shares untouched subtrees.
 */
import { panesOf, type LayoutSpec, type Node, type Pane } from "./spec";

function mapNode(n: Node, f: (n: Node, path: number[]) => Node, path: number[] = []): Node {
  const mapped = f(n, path);
  if (mapped.kind === "pane") return mapped;
  let changed = mapped !== n;
  const children = mapped.children.map((c, i) => {
    const next = mapNode(c, f, [...path, i]);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...mapped, children } : mapped;
}

/** Replaces the ratios of the split at `path`. Ignored when the path is not a split of that arity. */
export function setRatiosAt(
  spec: LayoutSpec,
  path: readonly number[],
  ratios: number[],
): LayoutSpec {
  const key = path.join(".");
  const root = mapNode(spec.root, (n, p) =>
    n.kind === "split" && p.join(".") === key && n.ratios.length === ratios.length
      ? { ...n, ratios: [...ratios] }
      : n,
  );
  return root === spec.root ? spec : { ...spec, root };
}

/** Applies `f` to the pane with `id`. */
export function updatePane(spec: LayoutSpec, id: string, f: (p: Pane) => Pane): LayoutSpec {
  const root = mapNode(spec.root, (n) => (n.kind === "pane" && n.id === id ? f(n) : n));
  return root === spec.root ? spec : { ...spec, root };
}

export function setPaneCompact(spec: LayoutSpec, id: string, compact: boolean): LayoutSpec {
  return updatePane(spec, id, (p) => {
    if ((p.compact ?? false) === compact) return p;
    const { compact: _drop, ...rest } = p;
    void _drop;
    return compact ? { ...rest, compact: true } : rest;
  });
}

/** Every pane compact (R6.5). Ratios and assignments are untouched; panes already compact are shared. */
export function compactAll(spec: LayoutSpec): LayoutSpec {
  const root = mapNode(spec.root, (n) =>
    n.kind === "pane" && n.compact !== true ? { ...n, compact: true } : n,
  );
  return root === spec.root ? spec : { ...spec, root };
}

/** The session pane that holds `sessionId`, or undefined. */
export function sessionPaneOf(spec: LayoutSpec, sessionId: string): Pane | undefined {
  return panesOf(spec).find((p) => p.type === "session" && p.sessionId === sessionId);
}

function withSession(p: Pane, sessionId: string | undefined): Pane {
  if (p.sessionId === sessionId) return p;
  const { sessionId: _drop, ...rest } = p;
  void _drop;
  return sessionId === undefined ? rest : { ...rest, sessionId };
}

/**
 * Puts `sessionId` in the session pane `paneId`. Invariant: a session is in at most one session
 * pane. Rules, in one place:
 *  - the session was in no pane: it takes the target; the target's old session (if any) becomes
 *    unassigned (it is replaced, not moved);
 *  - the session was in another pane A and the target is empty: it moves (A becomes unassigned);
 *  - the session was in another pane A and the target holds another session X: they swap
 *    (A gets X), so dragging one pane onto another never loses a session;
 *  - the target already holds it, or the target is not a session pane: nothing changes.
 * Project and board panes show many sessions and are outside the invariant.
 */
export function assignSession(spec: LayoutSpec, paneId: string, sessionId: string): LayoutSpec {
  const panes = panesOf(spec);
  const target = panes.find((p) => p.id === paneId);
  if (!target || target.type !== "session") return spec;
  const source = panes.find(
    (p) => p.type === "session" && p.id !== paneId && p.sessionId === sessionId,
  );
  const displaced = target.sessionId === sessionId ? undefined : target.sessionId;
  let next = updatePane(spec, paneId, (p) => withSession(p, sessionId));
  // Clear every other holder (a stored spec could carry duplicates), swapping only into the first.
  for (const p of panes) {
    if (p.type !== "session" || p.id === paneId || p.sessionId !== sessionId) continue;
    const give = p === source ? displaced : undefined;
    next = updatePane(next, p.id, (q) => withSession(q, give));
  }
  return next;
}

/** Empties a session pane. */
export function unassignPane(spec: LayoutSpec, paneId: string): LayoutSpec {
  return updatePane(spec, paneId, (p) => (p.type === "session" ? withSession(p, undefined) : p));
}

/**
 * Enforces "a session is in at most one session pane" on any spec, whatever its source (hub row,
 * localStorage, a hand-edited file). The first holder in reading order keeps the session; later
 * holders become unassigned. Returns the same object when there is nothing to fix.
 */
export function dedupeSessions(spec: LayoutSpec): LayoutSpec {
  const seen = new Set<string>();
  let next = spec;
  for (const p of panesOf(spec)) {
    if (p.type !== "session" || p.sessionId === undefined) continue;
    if (seen.has(p.sessionId)) next = updatePane(next, p.id, (q) => withSession(q, undefined));
    else seen.add(p.sessionId);
  }
  return next;
}
