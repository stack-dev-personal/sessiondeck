/** R6.4 gate verdict from per-window attribution (plain function, unit-tested in src/trace.test.ts). */

export interface GateWindow {
  mode: "board" | "control";
  /** Dropped frames (rAF gaps and STATE_DROPPED) with 8 ms or more of the page's own main-thread work. */
  appDrops: number;
  /** Main-thread tasks over 50 ms (the larger of the observer's and the trace's count). */
  longTasks: number;
  /** Dropped frames that are not the app's. */
  otherDrops: number;
  /** Longest rAF gap that is not the app's, in vsyncs. */
  maxOtherGapVsyncs: number;
}

/** Windows of each kind the ABBA run must contain for the verdict to mean anything. */
export const MIN_PER_MODE = 4;
/** Two vsyncs, plus a little for timer jitter in the trace. */
export const MAX_OTHER_GAP_VSYNCS = 2.1;

export function judgeGate(ws: readonly GateWindow[]): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  const board = ws.filter((w) => w.mode === "board");
  const control = ws.filter((w) => w.mode === "control");
  if (board.length < MIN_PER_MODE || control.length < MIN_PER_MODE)
    failures.push(
      `need ${MIN_PER_MODE} board and ${MIN_PER_MODE} control windows, got ${board.length} and ${control.length}`,
    );
  ws.forEach((w, i) => {
    if (w.mode !== "board") return;
    if (w.appDrops > 0) failures.push(`window ${i + 1}: ${w.appDrops} app-attributed drops`);
    if (w.longTasks > 0) failures.push(`window ${i + 1}: ${w.longTasks} long tasks`);
    if (w.maxOtherGapVsyncs > MAX_OTHER_GAP_VSYNCS)
      failures.push(
        `window ${i + 1}: a non-app gap of ${w.maxOtherGapVsyncs} vsyncs (limit ${MAX_OTHER_GAP_VSYNCS})`,
      );
  });
  const sum = (l: readonly GateWindow[]) => l.reduce((n, w) => n + w.otherDrops, 0);
  if (sum(board) > sum(control) + 1)
    failures.push(`non-app drops: board ${sum(board)} > control ${sum(control)} + 1`);
  return { pass: failures.length === 0, failures };
}
