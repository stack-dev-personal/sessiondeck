import type { Envelope } from "@sessiondeck/contract";
import { fx, goldenEvents, statusLines } from "./fixtures";

/**
 * Builds the mock event stream from contract fixtures. Sessions are derived by rewriting
 * session_id, host and cwd; the golden session is cut at different points to land each session in
 * a different state. statusLine ticks are interleaved; their resets_at is moved to the future
 * relative to `now` so the windows are not treated as stale.
 */

interface Script {
  host: string;
  project: string;
  /** Distinct session_name shown on the card and in the drawer. */
  name: string;
  /** Synthetic worktree.branch / worktree.name emitted with the statusLine ticks. */
  branch?: string;
  worktree?: string;
  /** Hook payloads (already bare payloads) in order. */
  hooks: Record<string, unknown>[];
  /** Indices into statusLines; one tick is emitted after every `every` hooks. */
  status: number[];
  every: number;
  pid: number;
  /** Add liveness alive then dead at the end (exited). */
  dies?: boolean;
}

const G = goldenEvents;

/** State-neutral extra hooks: fixture payloads with their ids and subjects replaced. */
const subagent = (id: string, stopped: boolean): Record<string, unknown>[] => [
  { ...fx.subagentStart, agent_id: id, agent_type: "general-purpose" },
  ...(stopped
    ? [{ ...fx.subagentStart, agent_id: id, hook_event_name: "SubagentStop", agent_type: "" }]
    : []),
];
const tasks = (created: number, completed: number): Record<string, unknown>[] => [
  ...Array.from({ length: created }, (_, i) => ({
    ...fx.taskCreated,
    task_id: `task-${i + 1}`,
    task_subject: `Task ${i + 1} of ${created}`,
  })),
  ...Array.from({ length: completed }, (_, i) => ({
    ...fx.taskCompleted,
    task_id: `task-${i + 1}`,
    task_subject: `Task ${i + 1} of ${created}`,
  })),
];

/*
 * Status indices point at fixtures with a context percentage and both rate-limit windows
 * (04-mid 3, 05-mid 4, 10-keyset 9, 13-max-used 12, 16-max-five-hour 15, 19-max-seven-day 18).
 * The last entry is also emitted at the end of the script, so every session settles populated.
 */
const SCRIPTS: Script[] = [
  {
    host: "stack-lap",
    project: "bb2dash",
    name: "Port the chart widgets",
    branch: "feat/chart-widgets",
    worktree: "bb2dash-charts",
    hooks: [...G.slice(0, 92), ...tasks(2, 1)],
    status: [3, 4, 12],
    every: 20,
    pid: 4101,
  },
  {
    host: "stack-lap",
    project: "harvest",
    name: "Harvest scheduler retries",
    branch: "fix/scheduler-retry",
    hooks: [...G.slice(0, 217), ...subagent("mock-agent-h1", false), ...tasks(4, 2)],
    status: [3, 9, 4],
    every: 40,
    pid: 4102,
  },
  {
    host: "stack-box",
    project: "sessiondeck",
    name: "Board mock and drawer",
    branch: "p3/board-mock",
    hooks: [
      ...G.slice(0, 100),
      G[216]!,
      ...G.slice(100, 120),
      ...subagent("mock-agent-s1", false),
      ...subagent("mock-agent-s2", false),
      ...subagent("mock-agent-s3", true),
      ...tasks(3, 1),
    ],
    status: [9, 3, 15],
    every: 25,
    pid: 5101,
  },
  {
    host: "stack-box",
    project: "atlas",
    name: "Atlas tile cache",
    branch: "perf/tile-cache",
    hooks: [...G, ...tasks(5, 5)],
    status: [3, 4, 9],
    every: 55,
    pid: 5102,
  },
  {
    host: "stack-lap",
    project: "scratch",
    name: "Scratch pad",
    hooks: [fx.sessionStart],
    status: [],
    every: 1,
    pid: 4103,
  },
  {
    host: "stack-box",
    project: "docs-site",
    name: "Docs navigation",
    branch: "docs/nav-rework",
    hooks: [fx.sessionStart, fx.userPrompt, fx.askPreTool, fx.stopAfterAsk],
    status: [18],
    every: 2,
    pid: 5103,
  },
  {
    host: "stack-lap",
    project: "ingest-api",
    name: "Ingest API rate limits",
    branch: "fix/ingest-429",
    hooks: [fx.sessionStart, fx.userPrompt, fx.stopFailure],
    status: [15],
    every: 2,
    pid: 4104,
  },
  {
    host: "stack-box",
    project: "old-spike",
    name: "Old spike cleanup",
    branch: "spike/old-queue",
    hooks: G.slice(0, 60),
    status: [4],
    every: 30,
    pid: 5104,
    dies: true,
  },
];

const ULID_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(n: number): string {
  let s = "";
  let x = n;
  for (let i = 0; i < 25; i++) {
    s = ULID_CHARS[x % 32]! + s;
    x = Math.floor(x / 32);
  }
  return "0" + s;
}

const PROMPT_POOL = [
  "Refactor the session store so board updates are coalesced per animation frame, then run the full test suite and report anything that fails.",
  "Fix the lint errors in the parser module and run the tests again",
  "Add a regression test for the empty transcript case",
  "Which approach do you prefer for the migration?",
  "Run the tests",
  "Fix the build",
  "Ok",
];
const ASSISTANT_POOL = [
  "Done. I updated the parser, added a regression test and the full suite passes; the diff is ready for review. One follow-up remains: the migration script still needs a dry-run flag.",
  "Done. The checks pass and the diff is ready for review.",
  "I updated the parser and added a regression test.",
  "Tests pass",
  "Done",
  "Ok",
];
const OTHER_POOL = ["Reading the config", "Updating the parser", "Run the tests", "Done", "Ok"];

function poolFor(key: string): string[] {
  if (key === "prompt") return PROMPT_POOL;
  if (key === "last_assistant_message") return ASSISTANT_POOL;
  return OTHER_POOL;
}

/**
 * Readable stand-in for a scrubbed `<TEXT n>` placeholder: the longest phrase of the pool for the
 * field (`prompt`, `last_assistant_message`, anything else) that fits in n characters.
 */
export function synthText(n: number, key = ""): string {
  const fit = poolFor(key)
    .filter((p) => p.length <= n)
    .sort((a, b) => b.length - a.length)[0];
  return fit ?? "x".repeat(Math.max(1, n));
}

/** Replaces scrubber placeholders (<TEXT n>, <HOME>, <PROJECT_x>) inside any string. */
function humanize(v: unknown, project: string, key = ""): unknown {
  if (typeof v === "string") {
    return v
      .replace(/<TEXT (\d+)>/g, (_, n: string) => synthText(Number(n), key))
      .replace(/<HOME>/g, "/home/dev")
      .replace(/<PROJECT_\w+>/g, project);
  }
  if (Array.isArray(v)) return v.map((x) => humanize(x, project, key));
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, humanize(x, project, k)]),
    );
  }
  return v;
}

function rewrite(
  raw: Record<string, unknown>,
  sessionId: string,
  project: string,
): Record<string, unknown> {
  const payload = humanize(raw, project) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...payload, session_id: sessionId };
  if ("cwd" in out) out.cwd = `/home/dev/projects/${project}`;
  if ("transcript_path" in out) delete out.transcript_path;
  return out;
}

function rewriteStatus(
  payload: Record<string, unknown>,
  sessionId: string,
  sc: Script,
  now: number,
): Record<string, unknown> {
  const project = sc.project;
  const out = rewrite(payload, sessionId, project);
  out.session_name = sc.name;
  if (sc.branch) out.worktree = { name: sc.worktree ?? project, branch: sc.branch };
  const gitWorktree = (payload.workspace as { git_worktree?: string } | undefined)?.git_worktree;
  out.workspace = {
    ...(gitWorktree ? { git_worktree: sc.worktree ?? project } : {}),
    current_dir: `/home/dev/projects/${project}`,
    project_dir: `/home/dev/projects/${project}`,
  };
  const rl = out.rate_limits as
    { five_hour?: { resets_at?: number }; seven_day?: { resets_at?: number } } | null | undefined;
  if (rl) {
    out.rate_limits = {
      ...rl,
      five_hour: rl.five_hour && {
        ...rl.five_hour,
        resets_at: Math.floor(now / 1000) + 2 * 3600 + 600,
      },
      seven_day: rl.seven_day && { ...rl.seven_day, resets_at: Math.floor(now / 1000) + 3 * 86400 },
    };
  }
  const cache = out.prompt_cache as { expires_at?: number } | undefined;
  if (cache) out.prompt_cache = { ...cache, expires_at: Math.floor(now / 1000) + 1800 };
  return out;
}

/** Returns envelopes in delivery order, ts strictly increasing from `now - 30 min`. */
export function buildMockTimeline(now: number): Envelope[] {
  const perSession: Envelope[][] = SCRIPTS.map((sc, si) => {
    const sessionId = `mock-${sc.project}-${si + 1}`;
    const list: Omit<Envelope, "ts" | "seq" | "id">[] = [];
    const base = { v: 1 as const, host: sc.host, os: "linux" as const, session_id: sessionId };
    let tick = 0;
    sc.hooks.forEach((raw, i) => {
      const payload = rewrite(raw, sessionId, sc.project);
      const agent = typeof payload.agent_id === "string" ? payload.agent_id : undefined;
      list.push({
        ...base,
        kind: "hook",
        hook_event_name: String(payload.hook_event_name),
        ...(agent ? { agent_id: agent } : {}),
        payload,
      });
      if (i === 0) {
        list.push({ ...base, kind: "liveness", payload: { pid: sc.pid, alive: true } });
      }
      if (sc.status.length > 0 && (i + 1) % sc.every === 0) {
        const idx = sc.status[tick % sc.status.length]!;
        tick++;
        list.push({
          ...base,
          kind: "statusline",
          payload: rewriteStatus(
            statusLines[idx % statusLines.length] as Record<string, unknown>,
            sessionId,
            sc,
            now,
          ),
        });
      }
    });
    if (sc.status.length > 0) {
      const idx = sc.status[sc.status.length - 1]!;
      list.push({
        ...base,
        kind: "statusline",
        payload: rewriteStatus(statusLines[idx] as Record<string, unknown>, sessionId, sc, now),
      });
    }
    if (sc.dies) list.push({ ...base, kind: "liveness", payload: { pid: sc.pid, alive: false } });
    return list as Envelope[];
  });

  // Round-robin merge so every session moves at the same time.
  const merged: Envelope[] = [];
  const longest = Math.max(...perSession.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const l of perSession) if (l[i]) merged.push(l[i]!);
  }
  const start = now - 30 * 60_000;
  return merged.map((e, i) => ({
    ...e,
    id: ulid(i + 1),
    seq: i,
    ts: start + i * 1000,
  }));
}
