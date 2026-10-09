/** Session states derived by the hub from hook events (architecture 3.2). */
export const SESSION_STATES = [
  "starting",
  "working",
  "waiting_permission",
  "waiting_input",
  "idle",
  "error",
  "ended",
  "exited",
] as const;

export type SessionState = (typeof SESSION_STATES)[number];
