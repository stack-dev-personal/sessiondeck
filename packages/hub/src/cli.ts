// Maintenance subcommands: `replay` rebuilds snapshots from events, `compact` runs one retention
// pass. Neither needs HUB_TOKEN or opens a port. Exit codes: 0 ok, 2 usage, missing database or
// a file that is not a hub database, 3 a hub is serving this database (stop it first, or --force).
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { loadRetentionSettings } from "./config.ts";
import { Store } from "./db/store.ts";
import type { Logger } from "./ingest/ingestor.ts";
import { leaseRemainingMs } from "./lease.ts";
import { replay } from "./replay.ts";
import { DAY_MS, runRetention } from "./retention.ts";

const USAGE = "usage: main.mjs <replay|compact> [--db <path>] [--force] [--init]";

/** True when the file is a SQLite database that holds this hub's first migration. Opened read-only. */
function isHubDatabase(file: string): boolean {
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    return (
      db.prepare("SELECT 1 FROM schema_migrations WHERE version = 1 AND name = 'initial'").get() !==
      undefined
    );
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

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
  let force = false;
  let init = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === "--db" && rest[i + 1] !== undefined) db = rest[++i] as string;
    else if (a.startsWith("--db=")) db = a.slice(5);
    else if (a === "--force") force = true;
    else if (a === "--init") init = true;
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
  // Store.open creates schema_migrations and migrate() writes tables: never do that to a file
  // that is not already a hub database unless the operator said so.
  if (!init && !isHubDatabase(dbPath)) {
    out(
      `not a sessiondeck hub database (no migrations table): ${dbPath}\npass --init to initialize it as one`,
    );
    return 2;
  }
  const store = Store.open(dbPath);
  try {
    store.migrate();
    const held = leaseRemainingMs(store);
    if (held !== null && !force) {
      out(
        `a hub is serving ${dbPath} (lease expires in ${Math.ceil(held / 1000)} s). Stop the hub first, then run ${cmd} again.\n` +
          "Use --force only if you are sure no hub is serving this database.",
      );
      return 3;
    }
    if (cmd === "replay") {
      const now = Date.now();
      const r = replay(store, log, {
        maxOpenSessionsPerHost: cfg.maxOpenSessionsPerHost,
        sampleWindow: {
          minTs: now - cfg.sampleRetentionDays * DAY_MS,
          maxTs: now + cfg.maxClockSkewMs,
        },
      });
      out(
        `replay: sessions=${r.sessions} events=${r.events} samples=${r.samples} elapsed_ms=${r.elapsedMs} reducer_exceptions=${r.exceptions}`,
      );
    } else {
      const r = await runRetention(store, log, { ...cfg, compactMaxEvents: 0 });
      out(
        `compact: events=${r.compact.events} batches=${r.compact.batches} sessions=${r.compact.sessions} samples_deleted=${r.samples} elapsed_ms=${r.compact.elapsedMs} max_batch_ms=${r.compact.maxBatchMs} reducer_exceptions=${r.compact.exceptions}`,
      );
    }
    return 0;
  } finally {
    store.close();
  }
}
