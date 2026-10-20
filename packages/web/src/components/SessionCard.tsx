import { memo } from "react";
import type { SessionSnapshot, SessionState } from "@sessiondeck/contract";
import { STATE_VOCAB } from "../lib/state-vocab";
import { basename, formatClock, formatCost, formatDuration, shortModel } from "../lib/format";
import { Meter, MeterValue, metersFor } from "./Meter";
import { StateChip } from "./StateChip";

export const MAX_DOTS = 5;

const BADGE: Partial<Record<SessionState, string>> = {
  waiting_permission: "attention",
  waiting_input: "attention",
  error: "error",
  exited: "no SessionEnd",
};

/** Derived, display-ready fields shared by the full and compact card. */
export function cardInfo(s: SessionSnapshot) {
  const project = basename(s.project_dir) ?? basename(s.cwd) ?? s.session_id;
  const name = s.session_name ?? project;
  const active = s.subagents.filter((a) => a.ended_at === null).length;
  return { project, name, active, vocab: STATE_VOCAB[s.state] };
}

export function stateClasses(state: SessionState): string {
  const v = STATE_VOCAB[state];
  const cls: string[] = [];
  if (v.attention) cls.push("sd-attention");
  if (state === "ended" || state === "exited") cls.push("sd-dim");
  return cls.join(" ");
}

function ariaName(s: SessionSnapshot): string {
  const { name, vocab } = cardInfo(s);
  return `${name}, ${vocab.label}`;
}

/** Active subagents first so ended ones never push them into "+n". */
export function dotOrder(s: SessionSnapshot) {
  return [
    ...s.subagents.filter((a) => a.ended_at === null),
    ...s.subagents.filter((a) => a.ended_at !== null),
  ];
}

function SubagentDots({ s }: { s: SessionSnapshot }) {
  const shown = dotOrder(s).slice(0, MAX_DOTS);
  const extra = s.subagents.length - shown.length;
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" data-slot="dots">
      {shown.map((a) => (
        <span
          key={a.agent_id}
          data-dot={a.ended_at === null ? "active" : "ended"}
          aria-hidden="true"
          className={`num ${a.ended_at === null ? "text-state-working" : "text-fg-faint"}`}
        >
          {a.ended_at === null ? "●" : "○"}
        </span>
      ))}
      {extra > 0 ? (
        <span data-slot="dots-more" className="num text-fg-muted">
          +{extra}
        </span>
      ) : null}
    </span>
  );
}

function TaskProgress({ s, bar }: { s: SessionSnapshot; bar: boolean }) {
  const { total, completed } = s.tasks;
  const none = total === 0;
  return (
    <span
      className="inline-flex items-center gap-s-1"
      data-slot="tasks"
      title={s.tasks.last_subject ?? undefined}
    >
      <span className="num text-fg-muted">{none ? "n/a" : `${completed}/${total}`}</span>
      {bar ? (
        <span
          aria-hidden="true"
          className={`h-1.5 w-10 overflow-hidden rounded-sm ${
            none
              ? "border border-dashed border-border-strong"
              : "border border-transparent bg-meter-track"
          }`}
        >
          {none ? null : (
            <span
              className="block h-full bg-fg-muted"
              style={{ width: `${Math.min(100, (completed / total) * 100)}%` }}
            />
          )}
        </span>
      ) : null}
    </span>
  );
}

const ROW = "flex min-w-0 items-center gap-s-2 overflow-hidden whitespace-nowrap";

/**
 * Full session card, the 6-row anatomy of design system 5.1. Geometry is fixed: the card has an
 * explicit height and every row and slot renders for null data too ("n/a"), so values arriving
 * never move anything.
 */
function SessionCardImpl({
  s,
  now,
  exceeds200k = null,
}: {
  s: SessionSnapshot;
  now: number;
  exceeds200k?: boolean | null;
}) {
  const { project, name, active, vocab } = cardInfo(s);
  const meters = metersFor(s, now, exceeds200k);
  const badge = BADGE[s.state];
  const activity = s.last_assistant_message?.replace(/\s+/g, " ").trim() || null;
  const modelText = s.model
    ? `${shortModel(s.model.display_name)}${s.effort ? `·${s.effort}` : ""}`
    : "n/a";
  const wt = s.git.worktree;
  const where = `${project} · ${s.git.branch ?? "n/a"}${wt && wt !== project ? ` (${wt})` : ""}`;
  return (
    <article
      tabIndex={0}
      aria-label={ariaName(s)}
      data-testid="session-card"
      data-state={s.state}
      data-density="full"
      style={{ height: "var(--card-h)" }}
      className={`sd-card flex flex-col justify-between overflow-hidden rounded-lg border border-border bg-surface-1 px-s-3 py-s-2 text-sm ${stateClasses(s.state)}`}
    >
      <div data-row="1" className={`${ROW} justify-between`}>
        <span className={`${ROW} min-w-0`}>
          <StateChip state={s.state} detail={s.state_detail} />
          {badge ? (
            <span
              data-slot="badge"
              className={`shrink-0 rounded border border-current px-s-1 text-xs uppercase ${vocab.textClass}`}
            >
              {badge}
            </span>
          ) : null}
        </span>
        <span className="num min-w-0 truncate text-fg-muted">{where}</span>
      </div>
      <div data-row="2" className={`${ROW} justify-between`}>
        <span data-slot="name" className="min-w-0 flex-1 truncate">
          {s.session_name ? `"${name}"` : name}
        </span>
        <span data-slot="host" className="num shrink-0 text-xs text-fg-faint">
          {s.host}
        </span>
      </div>
      <div
        data-row="3"
        className="grid grid-cols-[1.7fr_1fr_1fr] gap-s-2 overflow-hidden whitespace-nowrap"
      >
        {meters.map((m) => (
          <Meter key={m.kind} m={m} />
        ))}
      </div>
      <div data-row="4" className={ROW}>
        <span aria-hidden="true" className="num shrink-0 text-fg-faint">
          ▸
        </span>
        <span
          data-slot="activity"
          className={`min-w-0 flex-1 truncate ${activity ? "" : "text-fg-muted"}`}
        >
          {activity ?? "n/a"}
        </span>
      </div>
      <div data-row="5" className={`${ROW} justify-between`}>
        <span className={ROW}>
          <SubagentDots s={s} />
          <span data-slot="agents" className="num shrink-0 text-fg-muted">
            {active} {active === 1 ? "agent" : "agents"}
          </span>
          <span className="shrink-0 text-fg-faint">tasks</span>
          <TaskProgress s={s} bar />
        </span>
        <span className={`${ROW} shrink-0`}>
          <span data-slot="cost" className="num text-fg-muted">
            {formatCost(s.cost.usd)}
          </span>
          <span data-slot="model" className="num text-fg-muted">
            {modelText}
          </span>
        </span>
      </div>
      <div data-row="6" className={`${ROW} text-xs text-fg-faint`}>
        <span data-slot="elapsed" className="num">
          {formatDuration(now - s.state_since)} in state
        </span>
        <span aria-hidden="true">·</span>
        <span data-slot="started" className="num">
          started {formatClock(s.started_at)}
        </span>
      </div>
    </article>
  );
}

export const SessionCard = memo(SessionCardImpl);

/** One-row form (design system 5.1 compact): state, project, name, three numbers, agents, tasks. */
function CompactCardImpl({
  s,
  now,
  exceeds200k = null,
}: {
  s: SessionSnapshot;
  now: number;
  exceeds200k?: boolean | null;
}) {
  const { project, name, active, vocab } = cardInfo(s);
  const meters = metersFor(s, now, exceeds200k);
  return (
    <article
      tabIndex={0}
      aria-label={ariaName(s)}
      data-testid="session-card"
      data-state={s.state}
      data-density="compact"
      style={{ height: "var(--card-compact-h)" }}
      className={`sd-card ${ROW} gap-s-3 rounded border border-border bg-surface-1 px-s-3 text-sm ${stateClasses(s.state)}`}
    >
      <span data-slot="state" className={`num shrink-0 ${vocab.textClass}`} title={vocab.label}>
        <span aria-hidden="true" className={s.state === "working" ? "sd-pulse" : ""}>
          {vocab.glyph}
        </span>{" "}
        <span className="text-xs">{vocab.label}</span>
      </span>
      <span data-slot="name" className="min-w-0 flex-1 truncate">
        <span className="num text-fg-muted">{project}</span> · {s.session_name ? `"${name}"` : name}
      </span>
      {meters.map((m) => (
        <MeterValue key={m.kind} m={m} />
      ))}
      <span data-slot="agents" className="num w-20 shrink-0 text-right text-fg-muted">
        {active} {active === 1 ? "agent" : "agents"}
      </span>
      <span className="shrink-0">
        <TaskProgress s={s} bar={false} />
      </span>
    </article>
  );
}

export const CompactCard = memo(CompactCardImpl);
