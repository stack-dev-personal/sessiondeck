import type { EventKind, HostOs } from "@sessiondeck/contract";
import type { SpoolLine } from "./spool-format.ts";
import { ulid } from "./ulid.ts";

export function hostOs(platform: NodeJS.Platform = process.platform): HostOs {
  if (platform === "win32" || platform === "darwin") return platform;
  return "linux";
}

export interface BuildInput {
  kind: EventKind;
  host: string;
  payload: unknown;
  session_id: string | null;
  agent_id?: string;
  hook_event_name?: string;
  ts?: number;
  id?: string;
}

/** Builds a spool line (a contract Envelope without seq). The payload is stored as given. */
export function buildEnvelope(input: BuildInput): SpoolLine {
  const ts = input.ts ?? Date.now();
  const env: SpoolLine = {
    v: 1, // ENVELOPE_VERSION; a literal so the hook bundle needs no runtime import of the contract
    id: input.id ?? ulid(ts),
    kind: input.kind,
    host: input.host,
    os: hostOs(),
    session_id: input.session_id,
    ts,
    payload: input.payload,
  };
  if (input.agent_id !== undefined) env.agent_id = input.agent_id;
  if (input.hook_event_name !== undefined) env.hook_event_name = input.hook_event_name;
  return env;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Spool line of kind hook from a parsed hook payload; null when session_id or event name is missing. */
export function hookEnvelopeFromPayload(
  payload: Record<string, unknown>,
  host: string,
  ts?: number,
): SpoolLine | null {
  const session_id = str(payload["session_id"]);
  const hook_event_name = str(payload["hook_event_name"]);
  if (!session_id || !hook_event_name) return null;
  const agent_id = str(payload["agent_id"]);
  return buildEnvelope({
    kind: "hook",
    host,
    payload,
    session_id,
    hook_event_name,
    ...(agent_id !== undefined ? { agent_id } : {}),
    ...(ts !== undefined ? { ts } : {}),
  });
}
