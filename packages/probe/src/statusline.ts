// statusLine entry: read bounded stdin, append the spool line FIRST, then print exactly one line.
// Never throws, never prints a stack trace, exits 0 always (a blank bar is worse than a fallback).
import { parseProbeArgs } from "./args.ts";
import { resolveHostName } from "./host.ts";
import { defaultProbeHome, hookErrorsLog, spoolDir } from "./paths.ts";
import { readStdin } from "./stdin.ts";
import { FALLBACK_LINE, renderStatusLine } from "./statusline/render.ts";
import { recordPayload } from "./statusline/record.ts";
import { setWindowsUtf8 } from "./win-utf8.ts";

function exit0(): never {
  process.exit(0);
}

function print(line: string): void {
  try {
    process.stdout.write(line + "\n", exit0);
    setTimeout(exit0, 500).unref();
  } catch {
    exit0();
  }
}

process.on("uncaughtException", () => {
  print(FALLBACK_LINE);
});
process.on("unhandledRejection", () => {
  print(FALLBACK_LINE);
});
process.stdout?.on?.("error", exit0);
process.stderr?.on?.("error", () => undefined);

async function main(): Promise<void> {
  const input = await readStdin();
  let line = FALLBACK_LINE;
  try {
    const args = parseProbeArgs(process.argv.slice(2));
    const home = args.home ?? defaultProbeHome();
    const res = recordPayload("statusline", input, {
      spool: spoolDir(home),
      host: args.host ?? resolveHostName(),
      errorLog: hookErrorsLog(home),
    });
    if (res.ok) line = renderStatusLine(res.payload);
  } catch {
    line = FALLBACK_LINE;
  }
  setWindowsUtf8();
  print(line);
}

main().catch(() => print(FALLBACK_LINE));
