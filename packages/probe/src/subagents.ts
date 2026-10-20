// subagentStatusLine entry: append the payload to the spool, print NOTHING so Claude Code keeps its
// default rows, exit 0 always.
import { parseProbeArgs } from "./args.ts";
import { resolveHostName } from "./host.ts";
import { defaultProbeHome, hookErrorsLog, spoolDir } from "./paths.ts";
import { readStdin } from "./stdin.ts";
import { recordPayload } from "./statusline/record.ts";

function exit0(): never {
  process.exit(0);
}
process.on("uncaughtException", exit0);
process.on("unhandledRejection", exit0);
process.stdout?.on?.("error", () => undefined);
process.stderr?.on?.("error", () => undefined);

async function main(): Promise<void> {
  const input = await readStdin();
  const args = parseProbeArgs(process.argv.slice(2));
  const home = args.home ?? defaultProbeHome();
  recordPayload("subagents", input, {
    spool: spoolDir(home),
    host: args.host ?? resolveHostName(),
    errorLog: hookErrorsLog(home),
  });
}

main().then(exit0, exit0);
