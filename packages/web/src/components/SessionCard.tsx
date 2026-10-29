import { memo, useId, useState, type AnimationEvent, type KeyboardEvent } from "react";
import type { SessionSnapshot, SessionState } from "@sessiondeck/contract";
import { displayNameOf, projectOf } from "../lib/attention";
import { STATE_VOCAB } from "../lib/state-vocab";
import { formatClock, formatCost, formatDuration, shortModel } from "../lib/format";
import { TRANSCRIPT_LABEL, costAria, fromTranscript, transcriptHint } from "../lib/provenance";
import { Meter, MeterValue, metersFor } from "./Meter";
import { SourceMark } from "./SourceMark";
import { StateChip } from "./StateChip";

export const MAX_DOTS = 5;

type Open = ((sessionId: string) => void) | undefined;

/** Click and Enter (not auto-repeat) on the card itself open the detail drawer. */
function openHandlers(id: string, onOpen: Open, hintId: string) {
  return {
    "aria-haspopup": "dialog" as const,
    "aria-describedby": hintId,
    "data-session-id": id,
    onClick: () => onOpen?.(id),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === "Enter" && !e.repeat && e.target === e.currentTarget) {
        e.preventDefault();
        onOpen?.(id);
      }
    },
  };
}

const BADGE: Partial<Record<SessionState, string>> = {
  waiting_permission: "attention",
  waiting_input: "attention",
  error: "error",
  exited: "no SessionEnd",
};

/** Derived, display-ready fields shared by the full and compact card. */
export function cardInfo(s: SessionSnapshot) {
  const project = projectOf(s);
  const name = displayNameOf(s);
  const active = s.subagents.filter((a) => a.ended_at === null).length;
  return { project, name, active, vocab: STATE_VOCAB[s.state] };
}

/**
 * One-time arrival glow: `arrive` is true from the render where the card enters attention (or
 * mounts in it) until the glow's animationend. Moving the card in the DOM later does not replay it.
 */
export function useArrive(attention: boolean) {
  const [arrive, setArrive] = useState(attention);
  const [prev, setPrev] = useState(attention);
  if (prev !== attention) {
    setPrev(attention);
    setArrive(attention);
  }
  const onAnimationEnd = (e: AnimationEvent<HTMLElement>) => {
    if (e.animationName === "sd-glow") setArrive(false);
  };
  return { arrive: arrive && attention, onAnimationEnd };
}

export function stateClasses(state: SessionState, arrive = false): string {
  const v = STATE_VOCAB[state];
  const cls: string[] = [];
  if (v.attention) cls.push("sd-attention");
  if (v.attention && arrive) cls.push("sd-arrive");
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
          data-slot="task-bar"
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
  onOpen,
}: {
  s: SessionSnapshot;
  now: number;
  exceeds200k?: boolean | null;
  onOpen?: (sessionId: string) => void;
}) {
  const hintId = useId();
  const { project, name, active, vocab } = cardInfo(s);
  const { arrive, onAnimationEnd } = useArrive(vocab.attention);
  const meters = metersFor(s, now, exceeds200k);
  const badge = BADGE[s.state];
  const activity = s.last_assistant_message?.replace(/\s+/g, " ").trim() || null;
  const modelText = s.model
    ? `${shortModel(s.model.display_name)}${s.effort ? `·${s.effort}` : ""}`
    : "n/a";
  const wt = s.git.worktree;
  const where = `${project} · ${s.git.branch ?? "n/a"}${wt && wt !== project ? ` (${wt})` : ""}`;
  const hint = transcriptHint(s);
  const branchTx = fromTranscript(s, "git_branch") && s.git.branch !== null;
  const modelTx = fromTranscript(s, "model") && s.model !== null;
  const activityTx = fromTranscript(s, "last_assistant_message") && activity !== null;
  const costTx = fromTranscript(s, "cost");
  return (
    <article
      tabIndex={0}
      aria-label={ariaName(s)}
      data-testid="session-card"
      {...openHandlers(s.session_id, onOpen, hintId)}
      data-state={s.state}
      data-attention={vocab.attention ? "true" : undefined}
      data-density="full"
      style={{ height: "var(--card-h)" }}
      className={`sd-card flex flex-col justify-between overflow-hidden rounded-lg border border-border bg-surface-1 px-s-3 py-s-2 text-sm ${stateClasses(s.state, arrive)}`}
      onAnimationEnd={onAnimationEnd}
    >
      <span id={hintId} className="sr-only">
        Enter opens details{hint ? `. ${hint}` : ""}
      </span>
      <div data-row="1" className={`${ROW} justify-between`}>
        <span data-slot="state" className={`${ROW} min-w-[12ch]`}>
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
        <span
          data-slot="where"
          title={branchTx ? `${where} (branch ${TRANSCRIPT_LABEL})` : where}
          className="num min-w-0 shrink-[8] truncate text-fg-muted"
        >
          {where}
          {branchTx ? <SourceMark /> : null}
        </span>
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
        data-slot="meters"
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
        {activityTx ? <SourceMark className="shrink-0" /> : null}
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
          <span
            data-slot="cost"
            role="group"
            aria-label={costAria(s)}
            title={costAria(s)}
            className="num text-fg-muted"
          >
            <span aria-hidden="true" className="text-xs text-fg-faint">
              API-equiv.{" "}
            </span>
            <span aria-hidden="true">{formatCost(s.cost.usd)}</span>
            {costTx ? <SourceMark /> : null}
          </span>
          <span
            data-slot="model"
            role="group"
            aria-label={`model ${modelText}${modelTx ? `, ${TRANSCRIPT_LABEL}` : ""}`}
            className="num text-fg-muted"
          >
            <span aria-hidden="true">{modelText}</span>
            {modelTx ? <SourceMark /> : null}
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
  onOpen,
}: {
  s: SessionSnapshot;
  now: number;
  exceeds200k?: boolean | null;
  onOpen?: (sessionId: string) => void;
}) {
  const hintId = useId();
  const { project, name, active, vocab } = cardInfo(s);
  const { arrive, onAnimationEnd } = useArrive(vocab.attention);
  const meters = metersFor(s, now, exceeds200k);
  return (
    <article
      tabIndex={0}
      aria-label={ariaName(s)}
      data-testid="session-card"
      {...openHandlers(s.session_id, onOpen, hintId)}
      data-state={s.state}
      data-attention={vocab.attention ? "true" : undefined}
      data-density="compact"
      style={{ height: "var(--card-compact-h)" }}
      className={`sd-card ${ROW} gap-s-3 rounded border border-border bg-surface-1 px-s-3 text-sm ${stateClasses(s.state, arrive)}`}
      onAnimationEnd={onAnimationEnd}
    >
      <span id={hintId} className="sr-only">
        Enter opens details
      </span>
      <span
        data-slot="state"
        className={`num w-36 shrink-0 truncate ${vocab.textClass}`}
        title={vocab.label}
      >
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
      <span data-slot="tasks-slot" className="flex w-16 shrink-0 justify-end">
        <TaskProgress s={s} bar={false} />
      </span>
    </article>
  );
}

export const CompactCard = memo(CompactCardImpl);
