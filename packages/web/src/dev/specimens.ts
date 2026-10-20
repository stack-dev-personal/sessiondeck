import {
  SESSION_STATES,
  createSnapshot,
  type SessionSnapshot,
  type SessionState,
  type SubagentSnapshot,
} from "@sessiondeck/contract";
import { applyStatusLine, exceeds200kOf } from "../statusline-adapter";

/**
 * Specimens for /dev/cards. Bases come from the contract statusLine fixtures (bundled by Vite);
 * synthetic overrides fill in values the fixtures lack (boundary percentages, a stale window,
 * subagents, a long name). This module is only reachable from the lazy dev route, which App
 * mounts in dev and mock builds only, so the production build carries no fixtures.
 */
const raw = import.meta.glob("../../../contract/fixtures/statusLine/{04-mid,13-max-used}.json", {
  eager: true,
  import: "default",
}) as Record<string, Record<string, unknown>>;

function fixture(re: RegExp): Record<string, unknown> {
  const hit = Object.entries(raw).find(([p]) => re.test(p));
  if (!hit) throw new Error(`dev fixture missing: ${re}`);
  return hit[1];
}

export interface Specimen {
  id: string;
  label: string;
  snapshot: SessionSnapshot;
  exceeds200k: boolean | null;
}

export interface SpecimenGroup {
  id: string;
  title: string;
  specimens: Specimen[];
}

function agents(n: number, ended = 0): SubagentSnapshot[] {
  return Array.from({ length: n }, (_, i) => ({
    agent_id: `agent-${i}`,
    agent_type: "general-purpose",
    started_at: 1,
    ended_at: i < ended ? 2 : null,
    tokens: 1000,
    context_window: 200_000,
    model: null,
  }));
}

export function buildSpecimens(now: number): SpecimenGroup[] {
  const base = (id: string, state: SessionState = "working"): SessionSnapshot => {
    const s = applyStatusLine(
      createSnapshot({ session_id: id, host: "stack-lap", cwd: "/w/bb2dash", ts: now - 720_000 }),
      fixture(/04-mid/),
      now,
    );
    return {
      ...s,
      session_id: id,
      host: "stack-lap",
      cwd: "/w/bb2dash",
      project_dir: "/w/bb2dash",
      state,
      state_since: now - 720_000,
      state_detail: state === "working" ? "tool:Edit" : null,
      started_at: now - 3_600_000,
      session_name: "Validate harvest against catalog",
      model: { id: "claude-opus", display_name: "Claude Opus 4.7" },
      effort: "high",
      context: { used_pct: 42, window: 200_000, input: 84_000, output: 1000 },
      rate_limits: {
        five_hour: { used_pct: 41, resets_at: now + 7_800_000 },
        seven_day: { used_pct: 30, resets_at: now + 3 * 86_400_000 },
        captured_at: now,
      },
      cost: { usd: 1.84, duration_ms: 1, lines_added: 1, lines_removed: 1 },
      subagents: agents(2),
      tasks: { total: 7, completed: 3, last_subject: "t" },
      git: { branch: "feat/phase-3", worktree: null, pr: null },
      last_assistant_message: "Editing src/harvest/validate.ts",
    };
  };
  const make = (id: string, label: string, over: Partial<SessionSnapshot> = {}): Specimen => ({
    id,
    label,
    snapshot: { ...base(id), ...over },
    exceeds200k: null,
  });
  const meterWith = (id: string, kind: "ctx" | "5h" | "7d", pct: number): Specimen => {
    const b = base(id);
    const win = { used_pct: pct, resets_at: now + 7_800_000 };
    return {
      id,
      label: `${kind} ${pct}%`,
      exceeds200k: null,
      snapshot:
        kind === "ctx"
          ? { ...b, context: { ...b.context, used_pct: pct } }
          : {
              ...b,
              rate_limits: { ...b.rate_limits, [kind === "5h" ? "five_hour" : "seven_day"]: win },
            },
    };
  };

  const states: Specimen[] = SESSION_STATES.map((st) => ({
    id: `state-${st}`,
    label: st,
    exceeds200k: null,
    snapshot: base(`state-${st}`, st),
  }));
  const compactStates: Specimen[] = states.map((s) => ({ ...s, id: `${s.id}-compact` }));

  return [
    { id: "states", title: "States, full card", specimens: states },
    { id: "states-compact", title: "States, compact row", specimens: compactStates },
    {
      id: "ctx",
      title: "Context thresholds (ok below 60, warn 60-80, high above 80)",
      specimens: [59, 60, 80, 81].map((p) => meterWith(`meter-ctx-${p}`, "ctx", p)),
    },
    {
      id: "5h",
      title: "5h thresholds (ok below 60, warn 60-85, high above 85)",
      specimens: [59, 60, 85, 86].map((p) => meterWith(`meter-5h-${p}`, "5h", p)),
    },
    {
      id: "7d",
      title: "7d thresholds (ok below 60, warn 60-85, high above 85)",
      specimens: [59, 60, 85, 86].map((p) => meterWith(`meter-7d-${p}`, "7d", p)),
    },
    {
      id: "nulls",
      title: "All-null snapshot beside a fully populated one (same geometry)",
      specimens: [
        {
          id: "all-null",
          label: "all null",
          exceeds200k: null,
          snapshot: {
            ...createSnapshot({
              session_id: "all-null",
              host: "stack-lap",
              cwd: "/w/empty",
              ts: now - 720_000,
            }),
            state: "idle",
          },
        },
        make("populated", "populated"),
      ],
    },
    {
      id: "edge",
      title: "Edge cases",
      specimens: [
        make("stale-window", "stale 5h window", {
          rate_limits: {
            five_hour: { used_pct: 90, resets_at: now - 60_000 },
            seven_day: { used_pct: 30, resets_at: now + 3 * 86_400_000 },
            captured_at: now - 3_600_000,
          },
        }),
        {
          ...make("over-200k", "200k+ tag", {
            context: { used_pct: 45, window: 1_000_000, input: 450_000, output: 1000 },
          }),
          exceeds200k: exceeds200kOf(fixture(/13-max-used/)),
        },
        make("subagents-12", "12 subagents", { subagents: agents(12, 3) }),
        make("long-name", "long name truncation", {
          session_name:
            "A very long session name that keeps going well past the width of any card in the grid",
          git: {
            branch: "feat/an-extremely-long-branch-name-for-truncation",
            worktree: "wt",
            pr: null,
          },
          last_assistant_message:
            "A long assistant message that must truncate on one line rather than wrap and grow the card, no matter how long it gets.",
        }),
      ],
    },
  ];
}
