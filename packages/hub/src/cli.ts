// Maintenance subcommands: `replay` rebuilds snapshots from events, `compact` runs one retention
// pass. Neither needs HUB_TOKEN or opens a port. Exit codes: 0 ok, 2 usage or missing database.
import { existsSync } from "node:fs";
import { loadRetentionSettings } from "./config.ts";
import { Store } from "./db/store.ts";
import type { Logger } from "./ingest/ingestor.ts";
import { replay } from "./replay.ts";
import { runRetention } from "./retention.ts";

const USAGE = "usage: main.mjs <replay|compact> [--db <path>]";

/** JSON lines on stderr, same shape as the server's pino lines (level, time, msg, fields). */
function stderrLogger(): Logger {
  const w = (level: number, obj: object, msg: string): void => {
    process.stderr.write(`${JSON.stringify({ level, time: Date.now(), ...obj, msg })}\n`);
  };
  return { info: (o, m) => w(30, o, m), warn: (o, m) => w(40, o, m) };
}

export async function runCli(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  out: (line: string) => void,
  log: Logger = stderrLogger(),
): Promise<number> {
  const [cmd, ...rest] = argv;
  let db: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === "--db" && rest[i + 1] !== undefined) db = rest[++i] as string;
    else if (a.startsWith("--db=")) db = a.slice(5);
    else {
      out(`unknown argument: ${a}\n${USAGE}`);
      return 2;
    }
  }
  if (cmd !== "replay" && cmd !== "compact") {
    out(`unknown command: ${cmd ?? ""}\n${USAGE}`);
    return 2;
  }
  const cfg = loadRetentionSettings(env);
  const dbPath = db ?? cfg.dbPath;
  if (!existsSync(dbPath)) {
    out(`database not found: ${dbPath}`);
    return 2;
  }
  const store = Store.open(dbPath);
  try {
    store.migrate();
    if (cmd === "replay") {
      const r = replay(store, log, { maxOpenSessionsPerHost: cfg.maxOpenSessionsPerHost });
      out(
        `replay: sessions=${r.sessions} events=${r.events} samples=${r.samples} elapsed_ms=${r.elapsedMs} reducer_exceptions=${r.exceptions}`,
      );
    } else {
      const r = await runRetention(store, log, cfg);
      out(
        `compact: events=${r.compact.events} batches=${r.compact.batches} sessions=${r.compact.sessions} samples_deleted=${r.samples} elapsed_ms=${r.compact.elapsedMs} max_batch_ms=${r.compact.maxBatchMs} reducer_exceptions=${r.compact.exceptions}`,
      );
    }
    return 0;
  } finally {
    store.close();
  }
}
