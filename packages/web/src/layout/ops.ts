/**
 * Pure reducers on a LayoutSpec. The layout store only calls these, so later units (compact-all
 * snapshot and restore, pane assignment, saved layouts) add reducers here without touching React.
 * Every reducer returns a new spec and shares untouched subtrees.
 */
import type { LayoutSpec, Node, Pane } from "./spec";

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
