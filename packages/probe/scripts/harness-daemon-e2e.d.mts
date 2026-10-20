export interface E2ECheck {
  name: string;
  ok: boolean;
  detail: string;
}
export function runDaemonE2E(o?: {
  log?: (line: string) => void;
}): Promise<{ checks: E2ECheck[]; pass: boolean }>;
