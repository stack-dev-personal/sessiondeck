import { ROW_STATES } from "./state-names";
import type { RowState } from "./state-names";
import type { DetailRule, Transition, TransitionTrigger } from "./transitions";
import { GUARD_DESCRIPTIONS, PROVISIONAL_BEHAVIOR } from "./transitions";

/** Generated documentation views of the transition table. Pure, deterministic, table order. */

/** A from-set missing at most this many states is shown as "any state except ...". */
const MAX_EXCLUDED_FOR_ANY = 2;

const NON_HOOK_TRIGGER_LABELS: Readonly<Record<string, string>> = {
  liveness_dead: "liveness alive false",
  superseded: "same pid, new session_id",
};

const DETAIL_TEXT: Readonly<Record<DetailRule, string>> = {
  clear: "null",
  keep_if_working: "unchanged if working, else null",
  keep_if_active: "unchanged if working or waiting_permission, else null",
  tool: "`tool:<tool_name>`",
  source: "`source:<source>`",
  needs_input: "needs input",
  awaiting_plan: "awaiting plan",
  error_type: "`<error>`",
  pid_gone: "process gone",
  superseded: "superseded",
};

function triggerLabel(trigger: TransitionTrigger): string {
  return NON_HOOK_TRIGGER_LABELS[trigger] ?? trigger;
}

function guardText(t: Transition): string {
  return t.guards.map((g) => GUARD_DESCRIPTIONS[g]).join(" and ");
}

function excludedStates(from: readonly RowState[]): RowState[] {
  return ROW_STATES.filter((s) => !from.includes(s));
}

/** Pseudo-node id and text when the from-set is nearly all states, else null. */
function anyNode(from: readonly RowState[]): { id: string; text: string } | null {
  const excluded = excludedStates(from);
  if (excluded.length === 0) return { id: "any_state", text: "any state" };
  if (excluded.length > MAX_EXCLUDED_FOR_ANY) return null;
  return {
    id: `any_except_${excluded.join("_")}`,
    text: `any state except ${excluded.join(" and ")}`,
  };
}

function edgeLabel(t: Transition): string {
  const guards = guardText(t);
  return guards === "" ? triggerLabel(t.trigger) : `${triggerLabel(t.trigger)} if ${guards}`;
}

/** Mermaid stateDiagram-v2 block (fenced) generated from the transition table. */
export function renderStateDiagram(table: readonly Transition[]): string {
  const declared = new Set<string>();
  const decls: string[] = [];
  const edges: string[] = [];
  for (const t of table) {
    const any = anyNode(t.from);
    if (any !== null && !declared.has(any.id)) {
      declared.add(any.id);
      decls.push(`    state "${any.text}" as ${any.id}`);
    }
    const sources = any === null ? t.from : [any.id];
    for (const source of sources) {
      edges.push(`    ${source} --> ${t.to} : ${edgeLabel(t)}`);
    }
  }
  return ["```mermaid", "stateDiagram-v2", "    [*] --> starting", ...decls, ...edges, "```"].join(
    "\n",
  );
}

function fromText(from: readonly RowState[]): string {
  const any = anyNode(from);
  return any === null ? from.join(", ") : any.text;
}

/** Markdown table of every transition row. */
export function renderTransitionTable(table: readonly Transition[]): string {
  const header = [
    "| Trigger | From | Condition | To | state_detail |",
    "| --- | --- | --- | --- | --- |",
  ];
  const rows = table.map((t) => {
    const cond = guardText(t) === "" ? "-" : guardText(t);
    return `| ${triggerLabel(t.trigger)} | ${fromText(t.from)} | ${cond} | ${t.to} | ${DETAIL_TEXT[t.detail]} |`;
  });
  return [...header, ...rows].join("\n");
}

/** Markdown table of the events whose behavior is provisional pending fixtures. */
export function renderProvisionalTable(): string {
  const header = ["| Event | Behavior now | Intended after fixtures |", "| --- | --- | --- |"];
  const rows = PROVISIONAL_BEHAVIOR.map((p) => `| ${p.event} | ${p.current} | ${p.intended} |`);
  return [...header, ...rows].join("\n");
}
