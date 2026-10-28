/**
 * A recorded headless session (R2.12): hooks plus transcript lines, no statusline. Built from the
 * committed transcript fixture 01-subagents (entrypoint sdk-cli, branch p1/hook-exe) and the hook
 * fixtures, re-keyed to the transcript's session id.
 */
import type { Envelope } from "@sessiondeck/contract";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BASE_TS, FIXTURES, STEP_MS, readJson, ulid } from "./sequences.ts";

export const HEADLESS_SESSION = "64504051-6a66-4050-809e-a952e025a5ff";
export const HEADLESS_BRANCH = "p1/hook-exe";
export const HEADLESS_MODEL = "claude-opus-5-5";
/** Tokens of the last assistant row of the fixture: 2 + 198 + 93972. */
export const HEADLESS_CONTEXT_TOKENS = 94_172;
export const HEADLESS_HOST = "laptop";
export const SUBAGENT_ID = "a0521282f787974c4";

const lines = (rel: string): string[] =>
  readFileSync(path.join(FIXTURES, rel), "utf8")
    .split("\n")
    .filter((l) => l !== "");

export const mainLines = (): string[] => lines("transcripts/01-subagents/session.jsonl");
export const subagentLines = (): string[] =>
  lines(`transcripts/01-subagents/subagents/agent-${SUBAGENT_ID}.jsonl`);

export class EnvSeq {
  readonly envelopes: Envelope[] = [];
  private n = 0;
  constructor(
    readonly host = HEADLESS_HOST,
    private readonly session = HEADLESS_SESSION,
    private readonly idBase = 5_000_000,
  ) {}

  private push(kind: Envelope["kind"], payload: unknown, extra: Partial<Envelope> = {}): Envelope {
    this.n++;
    const env: Envelope = {
      v: 1,
      id: ulid(this.idBase + this.n),
      kind,
      host: this.host,
      os: "linux",
      session_id: this.session,
      ts: BASE_TS + ((this.idBase - 5_000_000) / 1000) * STEP_MS + this.n * STEP_MS,
      seq: this.idBase + this.n,
      payload,
      ...extra,
    };
    this.envelopes.push(env);
    return env;
  }

  hook(file: string, over: Record<string, unknown> = {}): Envelope {
    const p: Record<string, unknown> = {
      ...(readJson(file) as Record<string, unknown>),
      session_id: this.session,
      ...over,
    };
    return this.push("hook", p, { hook_event_name: String(p["hook_event_name"]) });
  }

  statusline(file: string, over: Record<string, unknown> = {}): Envelope {
    return this.push("statusline", {
      ...(readJson(file) as Record<string, unknown>),
      session_id: this.session,
      ...over,
    });
  }

  /** Transcript lines in chunks of `size`, as the probe tailer sends them. */
  transcript(all: readonly string[], size: number, agent?: string, from = 0): Envelope[] {
    const out: Envelope[] = [];
    for (let i = 0; i < all.length; i += size) {
      out.push(
        this.push(
          "transcript",
          { start_line: from + i, lines: all.slice(i, i + size) },
          agent === undefined ? {} : { agent_id: agent },
        ),
      );
    }
    return out;
  }
}

/** SessionStart, UserPromptSubmit, the transcript (main plus one subagent file), Stop. */
export function headlessSession(host = HEADLESS_HOST): EnvSeq {
  const s = new EnvSeq(host);
  s.hook("SessionStart/01-startup.json", { model: "claude-fable-5-1" });
  s.hook("UserPromptSubmit/01-sample.json");
  s.transcript(mainLines(), 40);
  s.transcript(subagentLines(), 40, SUBAGENT_ID);
  s.hook("Stop/01-after-ask.json");
  return s;
}
