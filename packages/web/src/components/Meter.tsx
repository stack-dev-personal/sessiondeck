import { windowAt } from "../statusline-adapter";
import type { SessionSnapshot, Window } from "@sessiondeck/contract";
import {
  LEVEL_WORD,
  METER_NAME,
  clampPct,
  formatReset,
  formatTokens,
  levelFor,
  type Level,
  type MeterKind,
} from "../lib/format";

export interface MeterModel {
  kind: MeterKind;
  /** Short visible label: ctx, 5h, 7d. */
  label: string;
  pct: number | null;
  level: Level | null;
  /** Visible text beside the bar: "72%" or "n/a". */
  text: string;
  /** Spoken text, includes the threshold word for warn and high. */
  aria: string;
  title: string;
}

const CUE: Record<Level, string> = { ok: "", warn: "!", high: "!!" };
const FILL: Record<Level, string> = {
  ok: "bg-meter-ok",
  warn: "bg-meter-warn",
  high: "bg-meter-high",
};
const TEXT: Record<Level, string> = {
  ok: "text-fg",
  warn: "text-meter-warn",
  high: "text-meter-high",
};

function build(
  kind: MeterKind,
  label: string,
  pct: number | null,
  extra: string,
  title: string,
  spoken = "",
): MeterModel {
  if (pct === null) {
    return {
      kind,
      label,
      pct: null,
      level: null,
      text: "n/a",
      aria: `${METER_NAME[kind]} n/a`,
      title,
    };
  }
  const rounded = Math.round(pct);
  const level = levelFor(kind, rounded);
  const word = level === "ok" ? "" : `, ${LEVEL_WORD[level]}`;
  return {
    kind,
    label,
    pct,
    level,
    text: `${rounded}%${extra}`,
    aria: `${METER_NAME[kind]} ${rounded} percent${word}${spoken}`,
    title,
  };
}

/**
 * `exceeds200k` is the statusLine payload's exceeds_200k_tokens, kept beside the snapshot in the
 * board store (the contract snapshot has no field for it). null means unknown: no tag.
 */
export function contextModel(s: SessionSnapshot, exceeds200k: boolean | null = null): MeterModel {
  const win = s.context.window;
  const over = exceeds200k === true;
  const extra = over ? " · 200k+" : win !== null ? ` of ${formatTokens(win)}` : "";
  const spoken = `${over ? ", 200k+" : ""}${win !== null ? `, of ${formatTokens(win)}` : ""}`;
  const title = win !== null ? `context window ${formatTokens(win)}` : "context window n/a";
  return build("context", "ctx", s.context.used_pct, extra, title, spoken);
}

/** Rate-limit meters always read through windowAt so a past resets_at renders n/a. */
export function windowModel(
  kind: "five_hour" | "seven_day",
  raw: Window | null,
  now: number,
): MeterModel {
  const w = windowAt(raw, now);
  const reset = formatReset(raw?.resets_at ?? null, now);
  const stale = raw !== null && w.used_pct === null && raw.used_pct !== null;
  const title = stale
    ? "window reset, waiting for next sample"
    : reset
      ? `resets ${reset}`
      : "resets n/a";
  const m = build(kind, kind === "five_hour" ? "5h" : "7d", w.used_pct, "", title);
  return stale ? { ...m, aria: `${m.aria}, stale` } : m;
}

export function metersFor(
  s: SessionSnapshot,
  now: number,
  exceeds200k: boolean | null = null,
): MeterModel[] {
  return [
    contextModel(s, exceeds200k),
    windowModel("five_hour", s.rate_limits.five_hour, now),
    windowModel("seven_day", s.rate_limits.seven_day, now),
  ];
}

/** Bar + number. Fixed widths: the bar and the cue slot exist whether or not there is a value. */
export function Meter({ m }: { m: MeterModel }) {
  return (
    <div
      role="group"
      aria-label={m.aria}
      title={m.title}
      data-meter={m.kind}
      data-level={m.level ?? "na"}
      className="flex min-w-0 items-center gap-s-1"
    >
      <span aria-hidden="true" data-slot="label" className="w-6 shrink-0 text-fg-faint">
        {m.label}
      </span>
      <span
        aria-hidden="true"
        data-slot="bar"
        className={`h-1.5 w-8 shrink-0 overflow-hidden rounded-sm ${
          m.pct === null
            ? "border border-dashed border-border-strong"
            : "border border-transparent bg-meter-track"
        }`}
      >
        {m.level !== null && m.pct !== null ? (
          <span
            className={`block h-full ${FILL[m.level]}`}
            style={{ width: `${clampPct(m.pct)}%` }}
          />
        ) : null}
      </span>
      <span
        aria-hidden="true"
        data-slot="value"
        className={`num truncate whitespace-nowrap ${m.level ? TEXT[m.level] : "text-fg-muted"}`}
      >
        {m.text}
      </span>
      <span
        aria-hidden="true"
        data-slot="cue"
        className={`num w-4 shrink-0 ${m.level ? TEXT[m.level] : ""}`}
      >
        {m.level ? CUE[m.level] : ""}
      </span>
    </div>
  );
}

/** Number-only form for the compact row (bar omitted; number and cue stay). */
export function MeterValue({ m }: { m: MeterModel }) {
  return (
    <span
      role="group"
      aria-label={m.aria}
      title={m.title}
      data-meter={m.kind}
      data-level={m.level ?? "na"}
      className={`num inline-flex w-14 shrink-0 justify-end gap-s-1 whitespace-nowrap ${
        m.level ? TEXT[m.level] : "text-fg-muted"
      }`}
    >
      <span aria-hidden="true">{m.pct === null ? "n/a" : `${Math.round(m.pct)}%`}</span>
      <span aria-hidden="true" className="w-3 text-left">
        {m.level ? CUE[m.level] : ""}
      </span>
    </span>
  );
}
