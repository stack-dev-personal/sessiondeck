import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { SessionSnapshot } from "@sessiondeck/contract";
import { formatClockSec, formatDuration, formatReset, formatTokens } from "../lib/format";
import { STATE_VOCAB } from "../lib/state-vocab";
import { windowAt } from "../statusline-adapter";
import { EMPTY_HISTORY, type Sample, type SessionHistory } from "../store/history";
import { cardInfo } from "./SessionCard";
import { Meter, windowModel } from "./Meter";

/** Section ids in render order (design system 5.2). */
export const DRAWER_SECTIONS = [
  "timeline",
  "context",
  "limits",
  "subagents",
  "tasks",
  "prompt",
  "assistant",
  "git",
  "raw",
] as const;

const FOCUSABLE = 'button, a[href], [tabindex="0"]';

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const uid = useId();
  return (
    <section data-section={id} aria-labelledby={uid} className="flex flex-col gap-s-1">
      <h3 id={uid} className="m-0 text-xs font-normal uppercase tracking-wide text-fg-muted">
        {title}
      </h3>
      {children}
    </section>
  );
}

const NA = <span className="num text-fg-muted">n/a</span>;

const SPARK_W = 360;
const SPARK_H = 40;

/** Summary spoken by the sparkline; "n/a" with no samples. */
export function sparklineLabel(samples: readonly Sample[]): string {
  if (samples.length === 0) return "Context usage over time: n/a";
  const pcts = samples.map((p) => Math.round(p.pct));
  return `Context usage over time, ${samples.length} samples: min ${Math.min(...pcts)}%, max ${Math.max(...pcts)}%, latest ${pcts[pcts.length - 1]}%`;
}

function Sparkline({ samples }: { samples: readonly Sample[] }) {
  const last = samples[samples.length - 1];
  const points = samples
    .map((p, i) => {
      const x = samples.length === 1 ? SPARK_W : (i / (samples.length - 1)) * SPARK_W;
      const y = SPARK_H - (Math.min(100, Math.max(0, p.pct)) / 100) * SPARK_H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <div className="flex flex-col gap-s-1">
      <svg
        role="img"
        aria-label={sparklineLabel(samples)}
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        preserveAspectRatio="none"
        style={{ height: "var(--spark-h)" }}
        className={`w-full rounded border bg-surface-1 ${samples.length === 0 ? "border-dashed border-border-strong" : "border-border"}`}
      >
        {samples.length > 0 ? (
          <polyline
            points={points}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      <span className="num text-xs text-fg-muted">
        {last ? `latest ${Math.round(last.pct)}% · ${samples.length} samples` : "n/a"}
      </span>
    </div>
  );
}

function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

function Text({ value }: { value: string | null }) {
  return value ? (
    <p className="m-0 whitespace-pre-wrap break-words text-sm">{value}</p>
  ) : (
    <p className="num m-0 text-sm text-fg-muted">n/a</p>
  );
}

function Limit({
  kind,
  s,
  now,
}: {
  kind: "five_hour" | "seven_day";
  s: SessionSnapshot;
  now: number;
}) {
  const raw = s.rate_limits[kind];
  const fresh = windowAt(raw, now).used_pct !== null;
  const reset = fresh ? formatReset(raw?.resets_at ?? null, now) : null;
  return (
    <li className="flex items-center justify-between gap-s-2">
      <Meter m={windowModel(kind, raw, now)} />
      <span data-slot="reset" className="num text-xs text-fg-muted">
        {reset ? `resets ${reset}` : "n/a"}
      </span>
    </li>
  );
}

export interface DetailDrawerProps {
  session: SessionSnapshot;
  history?: SessionHistory;
  now: number;
  onClose: () => void;
}

/**
 * Right-side modal panel (design system 5.2). A fixed overlay: opening it never moves the board.
 * Focus goes to the close button on open and is trapped; Esc closes. Focus return to the card is
 * the host's job (it looks the card up by session id after this unmounts).
 */
export function DetailDrawer({
  session: s,
  history = EMPTY_HISTORY,
  now,
  onClose,
}: DetailDrawerProps) {
  const titleId = useId();
  const rawId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const { name, vocab } = cardInfo(s);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Everything behind the modal is inert while it is open, so focus cannot reach it.
  useEffect(() => {
    const dlg = ref.current;
    const siblings = dlg?.parentElement ? Array.from(dlg.parentElement.children) : [];
    const marked = siblings.filter(
      (el) => el !== dlg && !el.classList.contains("sd-scrim") && !el.hasAttribute("inert"),
    );
    for (const el of marked) el.setAttribute("inert", "");
    return () => {
      for (const el of marked) el.removeAttribute("inert");
    };
  }, []);

  // Document-level so it works wherever focus is, including document.body after a click on text.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
        return;
      }
      const root = ref.current;
      if (e.key !== "Tab" || !root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      const inside = root.contains(active);
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { tasks, git } = s;
  const prHref = git.pr ? safeHref(git.pr.url) : null;
  const timeline = [...history.transitions].reverse();
  return (
    <>
      <div aria-hidden="true" className="sd-scrim fixed inset-0 z-30" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="detail-drawer"
        data-session-id={s.session_id}
        style={{ width: "var(--drawer-w)" }}
        className="sd-drawer fixed right-0 top-0 z-40 flex h-full max-w-full flex-col border-l border-border bg-surface-1 text-sm"
      >
        <header className="flex items-start justify-between gap-s-2 border-b border-border p-s-3">
          <div className="min-w-0">
            <h2 id={titleId} className="m-0 truncate text-lg font-normal">
              {name}
            </h2>
            <span className={`inline-flex items-center gap-s-2 ${vocab.textClass}`}>
              <span aria-hidden="true" className="num">
                {vocab.glyph}
              </span>
              <span>{vocab.label}</span>
              {s.state_detail ? (
                <span className="num text-fg-muted">· {s.state_detail}</span>
              ) : null}
            </span>
            <div className="num text-xs text-fg-faint">{s.host}</div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="shrink-0 rounded border border-border-control bg-surface-2 px-s-2 py-s-1 text-sm text-fg hover:bg-surface-3"
          >
            Close (Esc)
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-s-4 overflow-y-auto p-s-3">
          <Section id="timeline" title="State timeline">
            {timeline.length === 0 ? (
              NA
            ) : (
              <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
                {timeline.map((t, i) => {
                  const v = STATE_VOCAB[t.state];
                  return (
                    <li
                      key={`${t.ts}-${timeline.length - i}`}
                      data-transition={t.state}
                      className={`flex items-center gap-s-2 ${v.textClass}`}
                    >
                      <span aria-hidden="true" className="num w-4">
                        {v.glyph}
                      </span>
                      <span>{v.label}</span>
                      {t.detail ? (
                        <span className="num truncate text-fg-muted">· {t.detail}</span>
                      ) : null}
                      <span className="num ml-auto shrink-0 text-xs text-fg-muted">
                        {formatClockSec(t.ts)}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </Section>
          <Section id="context" title="Context">
            <Sparkline samples={history.samples} />
          </Section>
          <Section id="limits" title="Rate limits">
            <ul className="m-0 flex list-none flex-col gap-s-1 p-0">
              <Limit kind="five_hour" s={s} now={now} />
              <Limit kind="seven_day" s={s} now={now} />
            </ul>
          </Section>
          <Section id="subagents" title="Subagents">
            {s.subagents.length === 0 ? (
              <p className="m-0 text-fg-muted">No subagents in this session.</p>
            ) : (
              <table className="w-full border-collapse text-left text-xs">
                <thead className="text-fg-muted">
                  <tr>
                    <th scope="col" className="font-normal">
                      Type
                    </th>
                    <th scope="col" className="text-right font-normal">
                      Tokens
                    </th>
                    <th scope="col" className="text-right font-normal">
                      Window
                    </th>
                    <th scope="col" className="font-normal pl-s-2">
                      Model
                    </th>
                    <th scope="col" className="text-right font-normal">
                      Elapsed
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {s.subagents.map((a) => (
                    <tr key={a.agent_id} data-agent={a.ended_at === null ? "active" : "ended"}>
                      <td className="max-w-0 truncate">
                        <span aria-hidden="true" className="num">
                          {a.ended_at === null ? "● " : "○ "}
                        </span>
                        {a.agent_type}
                      </td>
                      <td className="num text-right">
                        {a.tokens === null ? "n/a" : formatTokens(a.tokens)}
                      </td>
                      <td className="num text-right">
                        {a.context_window === null ? "n/a" : formatTokens(a.context_window)}
                      </td>
                      <td className="num pl-s-2">{a.model ?? "n/a"}</td>
                      <td className="num text-right">
                        {formatDuration((a.ended_at ?? now) - a.started_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
          <Section id="tasks" title="Tasks">
            {tasks.total === 0 ? (
              <p className="m-0 text-fg-muted">No tasks.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                <li>
                  <span aria-hidden="true" className="num">
                    ✔{" "}
                  </span>
                  <span className="num">{tasks.completed}</span> completed
                </li>
                <li>
                  <span aria-hidden="true" className="num">
                    ○{" "}
                  </span>
                  <span className="num">{tasks.total - tasks.completed}</span> open
                </li>
                {tasks.last_subject ? (
                  <li className="break-words">
                    <span aria-hidden="true" className="num">
                      ▸{" "}
                    </span>
                    <span className="text-fg-muted">latest:</span> {tasks.last_subject}
                  </li>
                ) : null}
              </ul>
            )}
          </Section>
          <Section id="prompt" title="Last prompt">
            <Text value={s.last_prompt} />
          </Section>
          <Section id="assistant" title="Last assistant message">
            <Text value={s.last_assistant_message} />
          </Section>
          <Section id="git" title="Git">
            <dl className="m-0 grid grid-cols-[5rem_1fr] gap-x-s-2 gap-y-0.5">
              <dt className="text-fg-muted">Branch</dt>
              <dd className="num m-0 break-all">{git.branch ?? "n/a"}</dd>
              <dt className="text-fg-muted">Worktree</dt>
              <dd className="num m-0 break-all">{git.worktree ?? "n/a"}</dd>
              <dt className="text-fg-muted">PR</dt>
              <dd className="num m-0">
                {git.pr && prHref ? (
                  <a
                    href={prHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent underline"
                  >
                    #{git.pr.number}
                  </a>
                ) : git.pr ? (
                  `#${git.pr.number}`
                ) : (
                  "n/a"
                )}
              </dd>
            </dl>
          </Section>
          <Section id="raw" title="Raw envelope tail">
            <button
              type="button"
              aria-expanded={rawOpen}
              aria-controls={rawId}
              onClick={() => setRawOpen((o) => !o)}
              className="self-start rounded border border-border-control bg-surface-2 px-s-2 py-s-1 text-xs text-fg hover:bg-surface-3"
            >
              <span aria-hidden="true">{rawOpen ? "▾ " : "▸ "}</span>
              {rawOpen ? "Hide" : "Show"} <span className="num">{history.tail.length}</span>{" "}
              envelopes
            </button>
            <div id={rawId}>
              {rawOpen ? (
                history.tail.length === 0 ? (
                  NA
                ) : (
                  <pre
                    tabIndex={0}
                    aria-label="Envelope JSON"
                    className="num m-0 max-h-80 overflow-auto rounded border border-border p-s-2 text-xs"
                  >
                    {history.tail.map((e) => JSON.stringify(e, null, 2)).join("\n")}
                  </pre>
                )
              ) : null}
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}
