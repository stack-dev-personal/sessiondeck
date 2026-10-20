// Production component set for the daemon process: the transcript tailer (R1.6) and the liveness
// monitor (R1.7). State files live under the probe home; the Claude config dir is only read.
import { daemonChild } from "../paths.ts";
import { LivenessMonitor } from "./liveness.ts";
import { projectsDir, sessionsDir } from "./sessions-file.ts";
import { TranscriptTailer } from "./transcript.ts";
import type { DaemonComponent } from "./types.ts";

export function defaultComponents(
  home: string,
  env: Record<string, string | undefined> = process.env,
): DaemonComponent[] {
  return [
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
