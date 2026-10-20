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
