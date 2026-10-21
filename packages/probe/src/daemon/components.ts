// Production component set for the daemon process: the transcript tailer (R1.6) and the liveness
// monitor (R1.7). State files live under the probe home; the Claude config dir is only read.
import { existsSync } from "node:fs";
import { daemonChild } from "../paths.ts";
import { LivenessMonitor } from "./liveness.ts";
import { projectsDir, sessionsDir } from "./sessions-file.ts";
import { TranscriptTailer } from "./transcript.ts";
import type { DaemonComponent } from "./types.ts";

/** Logs the two Claude directories the daemon reads, and warns when one is missing. */
export function dirsReport(env: Record<string, string | undefined> = process.env): DaemonComponent {
  return {
    name: "claude-dirs",
    start: (ctx): void => {
      for (const [what, dir] of [
        ["projectsDir", projectsDir(env)],
        ["sessionsDir", sessionsDir(env)],
      ] as const) {
        const ok = existsSync(dir);
        ctx.log(
          ok ? "info" : "warn",
          `${what}=${dir}${ok ? "" : " (missing: nothing is tracked until it exists)"}`,
        );
      }
    },
  };
}

export function defaultComponents(
  home: string,
  env: Record<string, string | undefined> = process.env,
): DaemonComponent[] {
  return [
    dirsReport(env),
    new TranscriptTailer({
      statePath: daemonChild(home, "transcript-offsets.json"),
      projectsDir: projectsDir(env),
    }),
    new LivenessMonitor({
      statePath: daemonChild(home, "liveness.json"),
      sessionsDir: sessionsDir(env),
    }),
  ];
}
