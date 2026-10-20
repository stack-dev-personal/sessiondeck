export interface LossResult {
  sent: number;
  accepted: number;
  duplicates: number;
  gaps: number;
  order: string;
  resent_ids: number;
  total_stored: number;
  [k: string]: unknown;
}
export function runKillScenario(o?: { total?: number; timeoutMs?: number }): Promise<LossResult>;
export function runOutageScenario(o?: {
  total?: number;
  outageMs?: number;
  timeoutMs?: number;
}): Promise<LossResult>;

export interface StoredEnvelope {
  seq: number;
  host: string;
  kind: string;
  session_id: string | null;
  agent_id?: string;
  hook_event_name?: string;
  payload: unknown;
}
export class StubHub {
  constructor(o?: { token?: string; port?: number });
  readonly url: string;
  readonly token: string;
  accepted: Map<string, StoredEnvelope>;
  order: string[];
  requests: number;
  resentIds: number;
  conflicts: number;
  start(): Promise<void>;
  stop(): Promise<void>;
}
export function killTree(child: unknown): Promise<void>;
export function spawnDaemon(
  home: string,
  env?: Record<string, string>,
): import("node:child_process").ChildProcess;
export function makeHome(hub: { url: string; token: string }): string;
export function makeUlid(ts: number, n: number): string;
