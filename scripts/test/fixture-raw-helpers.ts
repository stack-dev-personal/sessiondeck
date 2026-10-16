import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRIPTS_DIR, makeTempDir } from "./helpers";

export const INVENTORY = join(SCRIPTS_DIR, "fixture-inventory.mjs");
export const SCRUB = join(SCRIPTS_DIR, "fixture-scrub.mjs");
export const LEAK = join(SCRIPTS_DIR, "fixture-leak-check.mjs");
export const HOME = "C:\\Users\\zed";
export const SID_A = "11111111-2222-4333-8444-555555555555";
export const SID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

let counter = 0;
function put(
  root: string,
  event: string,
  payload: object,
  epoch = 1_000 + counter++,
  sid = SID_A,
): void {
  const dir = join(root, event);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${epoch}-${sid.slice(0, 8)}-r${counter}.json`), JSON.stringify(payload));
}

function hook(event: string, extra: object = {}, sid = SID_A): object {
  return {
    session_id: sid,
    transcript_path: `${HOME}\\.claude\\projects\\C--Users-zed-projects-alpha\\${sid}.jsonl`,
    cwd: `${HOME}\\projects\\alpha`,
    hook_event_name: event,
    ...extra,
  };
}

/** A raw directory with one complete session (start..end) and a few status samples. */
export function makeRaw(): string {
  const root = join(makeTempDir(), "raw");
  put(
    root,
    "SessionStart",
    hook("SessionStart", { source: "startup", model: "claude-test-1" }),
    10,
  );
  put(root, "UserPromptSubmit", hook("UserPromptSubmit", { prompt: "do the private thing" }), 20);
  put(
    root,
    "PreToolUse",
    hook("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "echo secret" },
      tool_use_id: "toolu_01ABCdefGHIjklMNOpqr12",
    }),
    30,
  );
  put(
    root,
    "PostToolUse",
    hook("PostToolUse", {
      tool_name: "AskUserQuestion",
      tool_input: {},
      tool_response: { interrupted: true },
    }),
    40,
  );
  put(
    root,
    "Stop",
    hook("Stop", { last_assistant_message: "the answer", stop_hook_active: false }),
    50,
  );
  put(root, "SessionEnd", hook("SessionEnd", { reason: "other" }), 60);
  put(root, "PostCompact", hook("PostCompact", { trigger: "auto", compact_summary: "s" }), 45);
  put(root, "SessionStart", hook("SessionStart", { source: "startup" }, SID_B), 15, SID_B);
  for (let i = 0; i < 6; i += 1) {
    put(
      root,
      "statusLine",
      {
        session_id: SID_A,
        cwd: `${HOME}\\projects\\alpha`,
        context_window: {
          used_percentage: i * 10,
          current_usage: i === 0 ? null : { input_tokens: 1 },
        },
        ...(i % 2 === 0
          ? { rate_limits: { five_hour: { used_percentage: i, resets_at: 1 } } }
          : {}),
      },
      100 + i * 10,
    );
  }
  for (let i = 0; i < 3; i += 1) {
    put(
      root,
      "subagentStatusLine",
      {
        session_id: SID_A,
        columns: 80,
        tasks: Array.from({ length: i }, () => ({ id: "x", description: "d" })),
      },
      200 + i,
    );
  }
  mkdirSync(join(root, "_state"), { recursive: true });
  writeFileSync(join(root, "_state", "ignored.json"), "{}");
  return root;
}

export function runNode(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", windowsHide: true });
}
