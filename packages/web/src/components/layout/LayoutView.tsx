/**
 * Renders a LayoutSpec: nested resizable splits with typed panes. Panel model after Crystal's
 * panels (MIT) as a mental model only; no code copied. Splitting is react-resizable-panels (MIT).
 *
 * The spec in the store is the single source of truth for ratios. The library gets them as
 * `defaultLayout`; only a user drag or key press (isUserInteraction) writes back, so mounting,
 * constraint changes and a later exact restore never overwrite the stored ratios.
 */
import { memo, useEffect, useRef } from "react";
import {
  Group,
  Panel,
  Separator,
  type GroupImperativeHandle,
  type Layout,
} from "react-resizable-panels";
import type { LayoutSpec, Node, Pane, Split } from "../../layout/spec";
import { pathKey } from "../../layout/spec";
import { useLayout } from "../../store/layout";
import {
  BoardPaneBody,
  CompactPaneBody,
  MetricsPaneBody,
  ProjectPaneBody,
  SessionPaneBody,
} from "./PaneBodies";
import { PaneChrome } from "./PaneChrome";

/** A pane may not be dragged smaller than this (px). A board pane needs its header plus one strip. */
const MIN_PANE_PX = 96;
const MIN_STRIP_PANE_PX = 64;

/** Narrowest a project column may be (rem): a full session card (28rem) plus the pane padding. */
export const PROJECT_COLUMN_REM = 30;

const nodeId = (n: Node, i: number): string => (n.kind === "pane" ? n.id : `split:${i}`);
const signature = (n: Node): string =>
  n.kind === "pane" ? n.id : `(${n.dir[0]}${n.children.map(signature).join(",")})`;

function PaneView({ pane }: { pane: Pane }) {
  const compact = pane.compact === true;
  return (
    <PaneChrome pane={pane}>
      {compact ? (
        <CompactPaneBody type={pane.type} sessionId={pane.sessionId} projectDir={pane.projectDir} />
      ) : pane.type === "board" ? (
        <BoardPaneBody />
      ) : pane.type === "session" ? (
        <SessionPaneBody sessionId={pane.sessionId} />
      ) : pane.type === "project" ? (
        <ProjectPaneBody projectDir={pane.projectDir} />
      ) : (
        <MetricsPaneBody />
      )}
    </PaneChrome>
  );
}

const toLayout = (split: Split): Layout =>
  Object.fromEntries(split.children.map((c, i) => [nodeId(c, i), split.ratios[i]! * 100]));

function SplitView({ split, path }: { split: Split; path: number[] }) {
  const setRatios = useLayout((s) => s.setRatios);
  const ref = useRef<GroupImperativeHandle | null>(null);
  const horizontal = split.dir === "row";
  // An external ratio change (restore, saved layout) is pushed into the mounted group.
  useEffect(() => {
    const g = ref.current;
    if (!g) return;
    const want = toLayout(split);
    const have = g.getLayout();
    if (Object.keys(want).some((k) => Math.abs((have[k] ?? 0) - want[k]!) > 0.01))
      g.setLayout(want);
  }, [split]);
  // A column per project must stay readable (R6.1): below this width the whole row scrolls sideways
  // instead of clipping the cards.
  const columns =
    horizontal && split.children.every((c) => c.kind === "pane" && c.type === "project");
  const group = (
    <Group
      groupRef={ref}
      id={`g-${pathKey(path)}`}
      orientation={horizontal ? "horizontal" : "vertical"}
      defaultLayout={toLayout(split)}
      onLayoutChanged={(layout, meta) => {
        if (!meta.isUserInteraction) return;
        setRatios(
          path,
          split.children.map((c, i) => (layout[nodeId(c, i)] ?? 0) / 100),
        );
      }}
      className="h-full w-full"
      data-testid="split"
      data-dir={split.dir}
    >
      {split.children.map((child, i) => {
        const id = nodeId(child, i);
        const stripPane = child.kind === "pane" && child.type === "board" && !horizontal;
        return [
          i > 0 ? (
            <Separator
              key={`sep-${id}`}
              className={`bg-border outline-none hover:bg-accent focus-visible:bg-accent data-[separator=active]:bg-accent ${horizontal ? "w-[var(--pane-gutter)]" : "h-[var(--pane-gutter)]"}`}
            />
          ) : null,
          <Panel key={id} id={id} minSize={stripPane ? MIN_STRIP_PANE_PX : MIN_PANE_PX}>
            <NodeView node={child} path={[...path, i]} />
          </Panel>,
        ];
      })}
    </Group>
  );
  if (!columns) return group;
  return (
    <div className="h-full w-full overflow-x-auto overflow-y-hidden" data-testid="split-scroll">
      <div
        className="h-full"
        style={{ minWidth: `${split.children.length * PROJECT_COLUMN_REM}rem` }}
      >
        {group}
      </div>
    </div>
  );
}

// The path is a fresh array every render, so compare it by value: a ratio change elsewhere must not
// re-render unrelated subtrees (node identity is shared by the reducers for untouched subtrees).
const NodeView = memo(
  function NodeView({ node, path }: { node: Node; path: number[] }) {
    if (node.kind === "pane") return <PaneView pane={node} />;
    // Keyed on structure so a different tree (preset switch) remounts its groups with fresh defaults.
    return <SplitView key={signature(node)} split={node} path={path} />;
  },
  (a, b) => a.node === b.node && pathKey(a.path) === pathKey(b.path),
);

export function LayoutView({ spec }: { spec: LayoutSpec }) {
  return (
    <div className="h-full w-full" data-testid="layout" data-layout-id={spec.id}>
      <NodeView key={spec.id + signature(spec.root)} node={spec.root} path={[]} />
    </div>
  );
}
