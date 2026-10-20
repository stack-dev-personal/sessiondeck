import { fixture, LIVE } from "../live-helpers";

/**
 * Load generator for R3.6. Creates `sessions` live sessions split over two hosts, then sustains
 * `rate` session deltas per second for as long as it runs.
 *
 * The hub broadcasts one `session` message per changed session per committed /ingest batch, so a
 * delta is only counted when a batch holds distinct sessions. Every tick (default 200 ms) posts one
 * batch per host with `perHostPerTick` envelopes for distinct sessions of that host, as the probe
 * would after a short spool interval: rate = 2 hosts * perHostPerTick / tickMs. Defaults give
 * 2 * 2 / 0.2 s = 20 deltas/s. The hub drops identical events within 5 s, so every payload carries
 * a counter (command text, cost, task id, agent id) and no two events are equal.
 *
 * The event mix (seeded, deterministic for one seed): tool Pre/Post pairs 50 %, statusLine ticks
 * 25 %, subagent start/stop 10 %, task created/completed 10 %, waiting_permission 5 % (a
 * PermissionRequest, answered by the next PostToolUse). Event time and ids are wall clock.
 */

export interface LoadOptions {
  seed?: number;
  hosts: [string, string];
  sessions?: number;
  tickMs?: number;
  perHostPerTick?: number;
}

export interface LoadStats {
  sent: number;
  posts: number;
  failedPosts: number;
  elapsedMs: number;
  /** Envelopes (== intended session deltas) per second over the run. */
  ratePerSec: number;
}

/** mulberry32: small seeded PRNG. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

interface Sess {
  id: string;
  host: string;
  cwd: string;
  toolOpen: boolean;
  agents: string[];
  tasks: string[];
}

type Env = Record<string, unknown>;

export function createLoad(opts: LoadOptions) {
  const rnd = prng(opts.seed ?? 20260620);
  const n = opts.sessions ?? 20;
  const tickMs = opts.tickMs ?? 200;
  const per = opts.perHostPerTick ?? 2;
  const seqs = new Map<string, number>();
  let counter = 0;
  let sent = 0;
  let posts = 0;
  let failedPosts = 0;

  const ulid = (): string => {
    let t = Date.now();
    let time = "";
    for (let i = 0; i < 10; i++) {
      time = CROCKFORD[t % 32]! + time;
      t = Math.floor(t / 32);
    }
    let r = "";
    for (let i = 0; i < 16; i++) r += CROCKFORD[Math.floor(rnd() * 32)]!;
    return time + r;
  };
  const hex = (len: number): string => {
    let s = "";
    for (let i = 0; i < len; i++) s += Math.floor(rnd() * 16).toString(16);
    return s;
  };
  const uuid = (): string => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;

  const sessions: Sess[] = Array.from({ length: n }, (_, i) => ({
    id: uuid(),
    host: opts.hosts[i % 2]!,
    cwd: `/w/load-${i % 6}`,
    toolOpen: false,
    agents: [],
    tasks: [],
  }));

  const envelope = (
    s: Sess,
    kind: "hook" | "statusline",
    name: string | undefined,
    rel: string,
    extra: Env = {},
    agentId?: string,
  ): Env => {
    const seq = (seqs.get(s.host) ?? 0) + 1;
    seqs.set(s.host, seq);
    return {
      v: 1,
      id: ulid(),
      kind,
      host: s.host,
      os: "linux",
      session_id: s.id,
      ...(agentId !== undefined ? { agent_id: agentId } : {}),
      ...(name !== undefined ? { hook_event_name: name } : {}),
      ts: Date.now(),
      seq,
      payload: {
        ...fixture(rel),
        session_id: s.id,
        cwd: s.cwd,
        ...(name !== undefined ? { hook_event_name: name } : {}),
        ...extra,
      },
    };
  };

  const statusline = (s: Sess): Env => {
    const c = ++counter;
    const base = fixture("statusLine/04-mid.json") as {
      context_window: Record<string, unknown>;
      cost: Record<string, unknown>;
    };
    return envelope(s, "statusline", undefined, "statusLine/04-mid.json", {
      context_window: {
        ...base.context_window,
        used_percentage: 5 + ((c * 7) % 90),
        total_input_tokens: 80_000 + c * 13,
      },
      cost: {
        ...base.cost,
        total_cost_usd: 1 + c * 0.013,
        total_duration_ms: 60_000 + c * 997,
      },
    });
  };

  const next = (s: Sess): Env => {
    const r = rnd();
    const c = ++counter;
    const tool = (): Env => {
      if (!s.toolOpen) {
        s.toolOpen = true;
        return envelope(s, "hook", "PreToolUse", "PreToolUse/10-bash.json", {
          tool_input: { command: `echo load ${c}`, description: `load ${c}` },
          tool_use_id: `toolu_load${c}`,
        });
      }
      s.toolOpen = false;
      return envelope(s, "hook", "PostToolUse", "PostToolUse/04-bash.json", {
        tool_input: { command: `echo load ${c}`, description: `load ${c}` },
        tool_use_id: `toolu_load${c}`,
        duration_ms: 100 + c,
      });
    };
    if (r < 0.5) return tool();
    if (r < 0.75) return statusline(s);
    if (r < 0.85) {
      const open = s.agents.shift();
      if (open !== undefined) {
        return envelope(
          s,
          "hook",
          "SubagentStop",
          "SubagentStop/01-subagent.json",
          { agent_id: open, last_assistant_message: `done ${c}` },
          open,
        );
      }
      const id = `ag${c}`;
      s.agents.push(id);
      return envelope(
        s,
        "hook",
        "SubagentStart",
        "SubagentStart/01-subagent.json",
        { agent_id: id, agent_type: "general-purpose" },
        id,
      );
    }
    if (r < 0.95) {
      const open = s.tasks.shift();
      if (open !== undefined) {
        return envelope(s, "hook", "TaskCompleted", "synthetic/TaskCompleted/01-synthetic.json", {
          task_id: open,
        });
      }
      const id = `task${c}`;
      s.tasks.push(id);
      return envelope(s, "hook", "TaskCreated", "synthetic/TaskCreated/01-synthetic.json", {
        task_id: id,
        task_subject: `load task ${c}`,
      });
    }
    if (s.toolOpen) return tool();
    s.toolOpen = true;
    return envelope(s, "hook", "PermissionRequest", "PermissionRequest/03-bash.json", {
      tool_input: { command: `rm -rf load-${c}`, description: `perm ${c}` },
    });
  };

  const post = async (host: string, envelopes: Env[]): Promise<void> => {
    posts++;
    try {
      const res = await fetch(`${LIVE.directUrl}/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${LIVE.token}` },
        body: JSON.stringify({ host, envelopes }),
      });
      if (!res.ok) failedPosts++;
      else sent += envelopes.length;
    } catch {
      failedPosts++;
    }
  };

  /** SessionStart, a prompt and a statusLine tick per session so every card is fully populated. */
  const setup = async (): Promise<void> => {
    for (const host of opts.hosts) {
      const batch: Env[] = [];
      for (const s of sessions.filter((x) => x.host === host)) {
        batch.push(envelope(s, "hook", "SessionStart", "SessionStart/01-startup.json"));
        batch.push(envelope(s, "hook", "UserPromptSubmit", "UserPromptSubmit/01-sample.json"));
        batch.push(statusline(s));
      }
      await post(host, batch);
    }
    sent = 0;
    posts = 0;
  };

  // Fair rotation: a shuffled queue per host, refilled when empty, so every session gets traffic
  // and the two or more picks in one tick are always distinct sessions.
  const queues = new Map<string, Sess[]>();
  const pick = (host: string, count: number): Sess[] => {
    const out: Sess[] = [];
    while (out.length < count) {
      let q = queues.get(host);
      if (q === undefined || q.length === 0) {
        q = sessions.filter((x) => x.host === host);
        for (let i = q.length - 1; i > 0; i--) {
          const j = Math.floor(rnd() * (i + 1));
          [q[i], q[j]] = [q[j]!, q[i]!];
        }
        queues.set(host, q);
      }
      const s = q.pop()!;
      if (!out.includes(s)) out.push(s);
    }
    return out;
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let startedAt = 0;
  let inflight: Promise<void> = Promise.resolve();

  const run = (): void => {
    running = true;
    startedAt = Date.now();
    let tick = 0;
    const step = (): void => {
      if (!running) return;
      tick++;
      const batches = opts.hosts.map((h) => ({
        h,
        envs: pick(h, per).map((s) => next(s)),
      }));
      inflight = Promise.all(batches.map((b) => post(b.h, b.envs))).then(() => undefined);
      // Fixed schedule (no drift): the next tick is due at startedAt + tick * tickMs.
      timer = setTimeout(step, Math.max(0, startedAt + tick * tickMs - Date.now()));
    };
    step();
  };

  const stop = async (): Promise<LoadStats> => {
    running = false;
    if (timer !== undefined) clearTimeout(timer);
    await inflight;
    const elapsedMs = Date.now() - startedAt;
    return { sent, posts, failedPosts, elapsedMs, ratePerSec: sent / (elapsedMs / 1000) };
  };

  /** SessionEnd for every session, so later specs on the same hub see no leftover working cards. */
  const end = async (): Promise<void> => {
    for (const host of opts.hosts) {
      const batch = sessions
        .filter((x) => x.host === host)
        .map((s) => envelope(s, "hook", "SessionEnd", "SessionEnd/01-other.json"));
      await post(host, batch);
    }
  };

  return { sessions, setup, run, stop, end };
}
