/**
 * Envelope sequences built from the committed contract fixtures. Only the envelope wrapper is
 * synthesized here (the fixtures are bare payloads). Shared by the golden test and by
 * scripts/gen-golden.ts, which folds the same sequences through the contract reducer.
 */
import type { Envelope } from "@sessiondeck/contract";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Walks up from this file (or its esbuild bundle in dist/) to packages/hub, then to the contract. */
function findHubRoot(): string {
  let dir = import.meta.dirname;
  while (!existsSync(path.join(dir, "vitest.config.ts"))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error("packages/hub root not found");
    dir = up;
  }
  return dir;
}
export const HUB_ROOT = findHubRoot();
export const FIXTURES = path.resolve(HUB_ROOT, "../contract/fixtures");
export const BASE_TS = 1_760_000_000_000;
/** Above the 5 s signature window so signature dedup never touches the golden sequences. */
export const STEP_MS = 6_000;

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function ulid(n: number): string {
  let s = "";
  let v = n;
  for (let i = 0; i < 25; i++) {
    s = B32[v % 32] + s;
    v = Math.floor(v / 32);
  }
  return `0${s}`;
}

export function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, rel), "utf8")) as Record<string, unknown>;
}

function listJson(dir: string): string[] {
  const abs = path.join(FIXTURES, dir);
  return readdirSync(abs)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => `${dir}/${f}`);
}

export interface Seq {
  name: string;
  host: string;
  envelopes: Envelope[];
}

class Builder {
  readonly envelopes: Envelope[] = [];
  constructor(readonly host: string) {}
  push(
    kind: Envelope["kind"],
    payload: unknown,
    extra: { session_id?: string | null; agent_id?: string; hook_event_name?: string } = {},
  ): Envelope {
    const i = this.envelopes.length;
    const p = payload as Record<string, unknown> | null;
    const sid =
      extra.session_id !== undefined
        ? extra.session_id
        : typeof p?.["session_id"] === "string"
          ? p["session_id"]
          : null;
    const agent =
      extra.agent_id ?? (typeof p?.["agent_id"] === "string" ? p["agent_id"] : undefined);
    const hook =
      extra.hook_event_name ?? (kind === "hook" ? String(p?.["hook_event_name"]) : undefined);
    const env: Envelope = {
      v: 1,
      id: ulid(i + 1),
      kind,
      host: this.host,
      os: "linux",
      session_id: sid,
      ...(agent !== undefined ? { agent_id: agent } : {}),
      ...(hook !== undefined ? { hook_event_name: hook } : {}),
      ts: BASE_TS + (i + 1) * STEP_MS,
      seq: i,
      payload,
    };
    this.envelopes.push(env);
    return env;
  }
}

function goldenPayloads(): Record<string, unknown>[] {
  return readFileSync(path.join(FIXTURES, "sessions/golden-session.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

export const GOLDEN_SESSION_ID = "fef17e22-168c-4fef-8964-9af573b7f2e9";

export function goldenSession(): Seq {
  const b = new Builder("golden-host");
  for (const p of goldenPayloads()) b.push("hook", p);
  return { name: "golden-session", host: b.host, envelopes: b.envelopes };
}

/** Every hook fixture (captured and synthetic), one envelope each, grouped by session in the oracle. */
export function fixtureMix(): Seq {
  const b = new Builder("mix-host");
  const dirs = readdirSync(FIXTURES)
    .filter(
      (d) =>
        !["raw", "settings", "sessions", "synthetic", "statusLine", "subagentStatusLine"].includes(
          d,
        ),
    )
    .filter((d) => statSync(path.join(FIXTURES, d)).isDirectory())
    .sort();
  const files = [
    ...dirs.flatMap((d) => listJson(d)),
    ...readdirSync(path.join(FIXTURES, "synthetic"))
      .sort()
      .flatMap((d) => listJson(`synthetic/${d}`)),
  ];
  for (const f of files) b.push("hook", readJson(f));
  return { name: "fixture-mix", host: b.host, envelopes: b.envelopes };
}

/** All five kinds on one session, plus a second session that is reported dead. */
export function allKinds(): Seq {
  const b = new Builder("kinds-host");
  const hooks = goldenPayloads();
  const S = GOLDEN_SESSION_ID;
  const subIdx = hooks.findIndex((h) => h["hook_event_name"] === "SubagentStart");
  const subId = String(hooks[subIdx]?.["agent_id"]);
  const stat = (f: string, extra: Record<string, unknown> = {}) => ({
    ...readJson(f),
    session_id: S,
    ...extra,
  });
  hooks.forEach((p, i) => {
    b.push("hook", p);
    if (i === 0) b.push("liveness", { pid: 4242, alive: true }, { session_id: S });
    if (i === 5) b.push("statusline", stat("statusLine/03-first-tick.json"));
    if (i === 10) b.push("statusline", stat("statusLine/13-max-used.json"));
    if (i === 60) b.push("statusline", stat("statusLine/06-usage-null.json"));
    if (i === 120) b.push("statusline", stat("statusLine/16-max-five-hour.json"));
    if (i === 20) {
      b.push(
        "transcript",
        { start_line: 0, lines: ['{"a":1}', '{"a":2}', '{"a":3}'] },
        { session_id: S },
      );
      b.push(
        "transcript",
        { start_line: 3, lines: ['{"a":4}'] },
        { session_id: S, agent_id: subId },
      );
    }
    if (i === subIdx + 3) {
      const sub = readJson("subagentStatusLine/01-rows-2.json") as {
        tasks: Record<string, unknown>[];
      };
      const tasks = sub.tasks.map((t, k) => (k === 0 ? { ...t, id: subId, tokenCount: 1234 } : t));
      b.push("subagents", { ...sub, session_id: S, tasks }, { session_id: S });
    }
  });
  b.push("probe", { event: "started" }, { session_id: null });
  const T = "kinds-second-session";
  b.push("hook", { ...readJson("SessionStart/01-startup.json"), session_id: T });
  b.push("liveness", { pid: 5555, alive: true }, { session_id: T });
  b.push("liveness", { pid: 5555, alive: false }, { session_id: T });
  return { name: "all-kinds", host: b.host, envelopes: b.envelopes };
}

/** Session B starts under the pid of session A: A ends as superseded. */
export function supersede(): Seq {
  const b = new Builder("super-host");
  const start = readJson("SessionStart/01-startup.json");
  b.push("hook", { ...start, session_id: "sess-A" });
  b.push("liveness", { pid: 77, alive: true }, { session_id: "sess-A" });
  b.push("hook", { ...start, session_id: "sess-B" });
  b.push("liveness", { pid: 77, alive: true }, { session_id: "sess-B" });
  b.push("hook", { ...start, session_id: "sess-C" });
  b.push("liveness", { pid: 88, alive: true }, { session_id: "sess-C" });
  return { name: "supersede", host: b.host, envelopes: b.envelopes };
}

/**
 * Every statusLine (20) and subagentStatusLine (5) fixture (R2.3). Each fixture keeps the
 * session_id it carries, so the 25 fixtures fold into 10 sessions. A SubagentStart hook for each
 * task id precedes the first subagents fixture that names it, so applySubagents has rows to update.
 */
export function allStatusLines(): Seq {
  const b = new Builder("status-host");
  for (const f of listJson("statusLine")) b.push("statusline", readJson(f));
  const started = new Set<string>();
  for (const f of listJson("subagentStatusLine")) {
    const fx = readJson(f) as { session_id: string; cwd?: string; tasks: { id: string }[] };
    for (const t of fx.tasks) {
      if (started.has(`${fx.session_id}/${t.id}`)) continue;
      started.add(`${fx.session_id}/${t.id}`);
      b.push("hook", {
        session_id: fx.session_id,
        cwd: fx.cwd ?? "",
        agent_id: t.id,
        agent_type: "general-purpose",
        hook_event_name: "SubagentStart",
      });
    }
    b.push("subagents", fx);
  }
  return { name: "all-statuslines", host: b.host, envelopes: b.envelopes };
}

export const SEQUENCES: (() => Seq)[] = [
  goldenSession,
  fixtureMix,
  allKinds,
  supersede,
  allStatusLines,
];
