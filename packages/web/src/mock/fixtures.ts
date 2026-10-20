/** Contract fixtures bundled into the browser build. Vite inlines them at build time; no fetch. */
const golden = import.meta.glob("../../../contract/fixtures/sessions/golden-session.jsonl", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const json = import.meta.glob(
  [
    "../../../contract/fixtures/{SessionStart,UserPromptSubmit,PreToolUse,PostToolUse,PermissionRequest,Stop,statusLine}/*.json",
    "../../../contract/fixtures/synthetic/StopFailure/*.json",
  ],
  { eager: true, import: "default" },
) as Record<string, Record<string, unknown>>;

function byName(re: RegExp): Record<string, unknown> {
  const hit = Object.entries(json).find(([path]) => re.test(path));
  if (!hit) throw new Error(`mock fixture missing: ${re}`);
  return hit[1];
}

export const goldenEvents: Record<string, unknown>[] = Object.values(golden)[0]!
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as Record<string, unknown>);

export const fx = {
  sessionStart: byName(/SessionStart\/01-startup\.json$/),
  userPrompt: byName(/UserPromptSubmit\/01-sample\.json$/),
  askPreTool: byName(/PreToolUse\/04-askuserquestion\.json$/),
  stopAfterAsk: byName(/Stop\/01-after-ask\.json$/),
  stopFailure: byName(/synthetic\/StopFailure\/01-synthetic\.json$/),
};

export const statusLines: Record<string, unknown>[] = Object.entries(json)
  .filter(([path]) => path.includes("/statusLine/"))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, v]) => v);
