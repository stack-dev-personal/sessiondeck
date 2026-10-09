#!/usr/bin/env node
/**
 * Registers (and removes) the sessiondeck fixture capture hook in the Claude Code settings file.
 *
 *   node scripts/capture-install.mjs [--out <dir>]               preview (writes nothing)
 *   node scripts/capture-install.mjs --apply [--out <dir>]       install
 *   node scripts/capture-install.mjs --uninstall [--apply]       preview / remove
 *
 * Run it yourself from a plain terminal, not from inside a Claude Code session: when CLAUDECODE is
 * set and the target is the default config directory it refuses, even for a preview.
 * Target: settings.json inside CLAUDE_CONFIG_DIR if set, else inside ~/.claude. The target path is
 * printed first. Only a diff of the lines this run adds or removes is printed, never the file.
 * Exit codes: 0 ok, 1 refused or failed (nothing half-written), 2 usage error.
 */
import { homedir } from "node:os";
import { run } from "./lib/install-cli.mjs";

process.exitCode = await run({
  argv: process.argv.slice(2),
  env: process.env,
  home: homedir(),
  print: (text) => process.stdout.write(`${text}\n`),
  printErr: (text) => process.stderr.write(`${text}\n`),
});
