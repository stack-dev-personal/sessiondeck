/**
 * Puts the children of `parent` into the order of `ids` (matched by `attr`) with the fewest DOM
 * moves: the longest run of children that is already in the right relative order stays put, every
 * other child is moved once. React's own reconciliation moves every child a moved one passes
 * (moving the k-th card to the front moves k-1 others), and each moved node is re-attached, so
 * its subtree pays style, layout and paint again (R3.6). Children whose id is not listed are not
 * touched and keep their place relative to the nodes around them.
 */
export function reorderChildren(parent: Element, ids: readonly string[], attr = "data-row"): void {
  const children = Array.from(parent.children);
  const byId = new Map<string, Element>();
  const index = new Map<Element, number>();
  children.forEach((c, i) => {
    index.set(c, i);
    const id = c.getAttribute(attr);
    if (id !== null) byId.set(id, c);
  });
  const want: Element[] = [];
  for (const id of ids) {
    const el = byId.get(id);
    if (el !== undefined) want.push(el);
  }
  const pos = want.map((el) => index.get(el)!);
  const stay = longestIncreasing(pos);
  let ref: Element | null = null;
  for (let i = want.length - 1; i >= 0; i--) {
    const el = want[i]!;
    if (!stay.has(i)) parent.insertBefore(el, ref);
    ref = el;
  }
}

/** Indices (into `a`) of one longest strictly increasing subsequence; O(n log n). */
function longestIncreasing(a: readonly number[]): Set<number> {
  const tails: number[] = []; // index in a of the smallest tail for each length
  const prev: number[] = new Array<number>(a.length).fill(-1);
  for (let i = 0; i < a.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[tails[mid]!]! < a[i]!) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const out = new Set<number>();
  for (let k = tails[tails.length - 1] ?? -1; k !== -1; k = prev[k]!) out.add(k);
  return out;
}
