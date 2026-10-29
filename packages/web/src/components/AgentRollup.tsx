import { useId, useMemo, useState } from "react";
import type { SubagentSnapshot } from "@sessiondeck/contract";
import { buildAgentTree, expandableIds, type AgentNode } from "../lib/agent-tree";
import { formatTokens } from "../lib/format";

/**
 * One subagent as a compact card: same shell (`sd-card`, `data-density="compact"`, fixed row
 * height) as the board's compact session card, so geometry is shared. A subagent has no session
 * state, so it shows running/ended as glyph plus word, never color alone.
 */
function AgentCard({
  node,
  expanded,
  onToggle,
  bodyId,
}: {
  node: AgentNode;
  expanded: boolean;
  onToggle: () => void;
  bodyId: string;
}) {
  const a: SubagentSnapshot = node.row;
  const running = a.ended_at === null;
  const n = node.children.length;
  return (
    <article
      data-testid="agent-card"
      data-agent-id={a.agent_id}
      data-density="compact"
      data-running={running ? "true" : "false"}
      aria-label={`${a.agent_type}, ${running ? "running" : "ended"}`}
      style={{ height: "var(--card-compact-h)" }}
      className="sd-card flex min-w-0 items-center gap-s-3 overflow-hidden whitespace-nowrap rounded border border-border bg-surface-1 px-s-3 text-sm"
    >
      {n > 0 ? (
        <button
          type="button"
          data-testid="agent-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${a.agent_type} ${a.agent_id}, ${n} ${n === 1 ? "subagent" : "subagents"}`}
          onClick={onToggle}
          className="num w-6 shrink-0 rounded border border-border-control bg-surface-2 text-fg hover:bg-surface-3"
        >
          <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        </button>
      ) : (
        <span aria-hidden="true" className="w-6 shrink-0" />
      )}
      <span
        data-slot="state"
        className={`num w-24 shrink-0 ${running ? "text-state-working" : "text-fg-muted"}`}
      >
        <span aria-hidden="true">{running ? "●" : "○"}</span>{" "}
        <span className="text-xs">{running ? "running" : "ended"}</span>
      </span>
      <span
        data-slot="name"
        className="flex min-w-0 flex-1 items-baseline gap-s-1"
        title={`${a.agent_type} ${a.agent_id}`}
      >
        <span data-slot="type" className="min-w-0 truncate">
          {a.agent_type}
        </span>
        <span data-slot="id" className="num shrink-0 text-fg-faint">
          {a.agent_id}
        </span>
      </span>
      {node.unlinked ? (
        <span
          data-slot="unlinked"
          title="Parent not known: shown at the first level"
          className="shrink-0 rounded border border-current px-s-1 text-xs uppercase text-fg-muted"
        >
          unlinked
        </span>
      ) : null}
      <span data-slot="model" className="num w-20 shrink-0 truncate text-fg-muted">
        {a.model ?? "n/a"}
      </span>
      <span data-slot="tokens" className="num w-16 shrink-0 text-right text-fg-muted">
        {a.tokens === null ? "n/a" : formatTokens(a.tokens)}
      </span>
    </article>
  );
}

function Level({
  nodes,
  open,
  toggle,
}: {
  nodes: readonly AgentNode[];
  open: ReadonlySet<string>;
  toggle: (id: string) => void;
}) {
  const uid = useId();
  return (
    <ul className="m-0 flex list-none flex-col gap-s-1 p-0">
      {nodes.map((n) => {
        const expanded = open.has(n.row.agent_id) && n.children.length > 0;
        const bodyId = `${uid}-${n.row.agent_id}`;
        return (
          <li key={n.row.agent_id} data-depth={n.depth} className="min-w-0">
            <AgentCard
              node={n}
              expanded={expanded}
              onToggle={() => toggle(n.row.agent_id)}
              bodyId={bodyId}
            />
            {expanded ? (
              <div id={bodyId} className="ml-s-4 mt-s-1 border-l border-border pl-s-2">
                <Level nodes={n.children} open={open} toggle={toggle} />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Subagents of one session as a bill-of-materials rollup (R3.11). Rows with a known parent nest
 * under it and expand in place, per node, to the deepest agent; "Expand all" / "Collapse all"
 * drives every node. Rows with no known parent sit at the first level with an "unlinked" marker.
 */
export function AgentRollup({ agents }: { agents: readonly SubagentSnapshot[] }) {
  const tree = useMemo(() => buildAgentTree(agents), [agents]);
  const expandable = useMemo(() => expandableIds(tree), [tree]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const allOpen = expandable.length > 0 && expandable.every((id) => open.has(id));
  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <section data-testid="agent-rollup" aria-label="Subagents" className="flex flex-col gap-s-2">
      <div className="flex items-center justify-between gap-s-2">
        <h3 className="m-0 text-xs font-normal uppercase tracking-wide text-fg-muted">
          Subagents <span className="num">({agents.length})</span>
        </h3>
        <button
          type="button"
          data-testid="agent-expand-all"
          disabled={expandable.length === 0}
          onClick={() => setOpen(allOpen ? new Set() : new Set(expandable))}
          className="rounded border border-border-control bg-surface-2 px-s-2 py-s-1 text-xs text-fg hover:bg-surface-3 disabled:text-fg-faint"
        >
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
      </div>
      {tree.length === 0 ? (
        <p className="m-0 text-fg-muted">No subagents.</p>
      ) : (
        <Level nodes={tree} open={open} toggle={toggle} />
      )}
    </section>
  );
}
