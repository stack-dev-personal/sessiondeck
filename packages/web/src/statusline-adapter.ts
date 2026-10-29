/*
 * The contract has no statusline-to-snapshot path (only StatusLinePayloadSchema and
 * normalizeRateLimitWindow). Until the hub owns this, the web applies the statusLine fields to a
 * snapshot here. Field mapping follows architecture 3.3 and snapshot.ts. Pure; never mutates.
 */
import type { SessionSnapshot, StatusLinePayload, Window } from "@sessiondeck/contract";
import {
  epochSecondsToMs,
  normalizeRateLimitWindow,
  parseStatusLinePayload,
} from "@sessiondeck/contract";

/**
 * Window as it should render at `now`: used_pct is null once resets_at has passed (architecture
 * 4: n/a until the next statusLine tick). Use this wherever a meter renders, not the raw window.
 */
export function windowAt(w: Window | null | undefined, now: number): Window {
  if (!w) return { used_pct: null, resets_at: null };
  if (w.resets_at !== null && now >= w.resets_at) return { used_pct: null, resets_at: w.resets_at };
  return w;
}

/** The payload's exceeds_200k_tokens; null when absent or not a boolean (unknown, no tag). */
export function exceeds200kOf(raw: unknown): boolean | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = (raw as Record<string, unknown>)["exceeds_200k_tokens"];
  return typeof v === "boolean" ? v : null;
}

function pickNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function applyStatusLine(prev: SessionSnapshot, raw: unknown, ts: number): SessionSnapshot {
  const parsed = safeParseStatusLine(raw);
  if (parsed === null) return { ...prev, last_event_at: ts };
  const p = parsed;
  const model =
    typeof p.model === "string"
      ? { id: p.model, display_name: p.model }
      : p.model?.id
        ? { id: p.model.id, display_name: p.model.display_name ?? p.model.id }
        : prev.model;
  const cw = p.context_window ?? null;
  const rl = p.rate_limits ?? null;
  const worktree = p.worktree ?? null;
  const pr = p.pr;
  const cache = p.prompt_cache;
  const expires = cache?.expires_at;
  return {
    ...prev,
    last_event_at: ts,
    model,
    effort: p.effort?.level ?? prev.effort,
    fast_mode: p.fast_mode ?? prev.fast_mode,
    session_name: p.session_name ?? prev.session_name,
    cwd: p.cwd ?? prev.cwd,
    project_dir: p.workspace?.project_dir ?? prev.project_dir,
    context: {
      used_pct: pickNumber(cw?.used_percentage) ?? null,
      window: pickNumber(cw?.context_window_size) ?? prev.context.window,
      input: pickNumber(cw?.total_input_tokens) ?? prev.context.input,
      output: pickNumber(cw?.total_output_tokens) ?? prev.context.output,
    },
    rate_limits:
      rl === null
        ? prev.rate_limits
        : {
            five_hour: normalizeRateLimitWindow(rl.five_hour, ts),
            seven_day: normalizeRateLimitWindow(rl.seven_day, ts),
            captured_at: ts,
          },
    cost: {
      usd: pickNumber(p.cost?.total_cost_usd) ?? prev.cost.usd,
      duration_ms: pickNumber(p.cost?.total_duration_ms) ?? prev.cost.duration_ms,
      lines_added: pickNumber(p.cost?.total_lines_added) ?? prev.cost.lines_added,
      lines_removed: pickNumber(p.cost?.total_lines_removed) ?? prev.cost.lines_removed,
    },
    git: {
      branch: worktree?.branch ?? prev.git.branch,
      worktree: worktree?.name ?? p.workspace?.git_worktree ?? prev.git.worktree,
      pr:
        pr && typeof pr.number === "number" && typeof pr.url === "string"
          ? { number: pr.number, url: pr.url }
          : prev.git.pr,
    },
    prompt_cache: cache
      ? {
          warm: cache.warm ?? false,
          expires_at: typeof expires === "number" ? epochSecondsToMs(expires) : null,
        }
      : prev.prompt_cache,
  };
}

function safeParseStatusLine(raw: unknown): StatusLinePayload | null {
  try {
    return parseStatusLinePayload(raw);
  } catch {
    return null;
  }
}
