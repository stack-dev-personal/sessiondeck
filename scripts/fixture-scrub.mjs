#!/usr/bin/env node
/**
 * Fixture scrub and select (R0.7 tooling). Reads raw captures, writes the scrubbed set.
 *
 *   node scripts/fixture-scrub.mjs [--raw <dir>] [--out <dir>]
 *
 * Defaults: --raw packages/contract/fixtures/raw, --out packages/contract/fixtures.
 * Output layout under --out:
 *   <Event>/NN-<slug>.json        hook payloads, one per distinct key-set/tool shape
 *   statusLine/NN-<tag>.json      20 samples;  subagentStatusLine/NN-<tag>.json  5 samples
 *   sessions/golden-session.jsonl one scrubbed hook payload per line, capture order
 *   synthetic/<Event>/NN-*.json   uncaptured events (see lib/fixture-synthetic.mjs)
 * Exits 1 after writing when a key name is not in lib/fixture-keys.mjs (written as <KEY_n>); the
 * key paths are listed, never the names. Deterministic: same raw set, same output. Prints counts only, never values. The raw directory
 * is only read. Everything written passes through the default-deny Scrubber.
 */
import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { FIXTURES_ROOT, RAW_ROOT, listEvents, readEvent } from "./lib/fixture-files.mjs";
import { Scrubber } from "./lib/fixture-scrub-core.mjs";
import { Mapper } from "./lib/fixture-scrub-paths.mjs";
import { buildSynthetic } from "./lib/fixture-synthetic.mjs";
import {
  pickExtras,
  pickGolden,
  pickHookGroups,
  pickStatusLine,
  pickSubagentStatus,
} from "./lib/fixture-select.mjs";

const STATUS_WANT = 20;
const SUBAGENT_WANT = 5;
const GOLDEN_MAX_EVENTS = 400;
const STATUS_DIRS = new Set(["statusLine", "subagentStatusLine"]);
/** Directories this script owns under --out; their generated files are replaced on each run. */
const OWNED = ["sessions", "synthetic"];

function arg(/** @type {string} */ name, /** @type {string} */ fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? /** @type {string} */ (process.argv[i + 1]) : fallback;
}

/** @param {string} s */
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/** File-name slug from the scrubbed payload (placeholders only, no content). */
function nameSlug(/** @type {any} */ p, /** @type {string} */ tag) {
  const bits = [];
  if (tag) bits.push(tag);
  for (const k of ["tool_name", "notification_type", "source", "reason", "trigger"]) {
    if (typeof p[k] === "string") bits.push(p[k]);
  }
  if (p.is_interrupt === true) bits.push("interrupt");
  if (p.agent_id !== undefined) bits.push("subagent");
  else if (p.agent_type !== undefined && p.agent_type !== "") bits.push("agent-session");
  return slug(bits.join("-")) || "sample";
}

function assertSafeOut(/** @type {string} */ out, /** @type {string} */ raw) {
  const rel = relative(resolve(raw), resolve(out));
  if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !/^[A-Za-z]:/.test(rel))) {
    throw new Error("output directory must not be inside the raw directory");
  }
}

/** Removes generated files from one owned directory (never recursive outside it). */
function clean(/** @type {string} */ dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      clean(p);
      if (readdirSync(p).length === 0) rmdirSync(p);
    } else if (/\.jsonl?$/.test(entry.name)) rmSync(p);
  }
}

function write(/** @type {string} */ path, /** @type {string} */ body) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf8");
}

function main() {
  const raw = resolve(arg("--raw", RAW_ROOT));
  const out = resolve(arg("--out", FIXTURES_ROOT));
  if (!existsSync(raw)) throw new Error("raw directory not found");
  assertSafeOut(out, raw);

  /** @type {Map<string, any[]>} */
  const byEvent = new Map();
  const paths = [];
  for (const ev of listEvents(raw)) {
    const { items } = readEvent(raw, ev);
    byEvent.set(ev, items);
    for (const it of items) {
      for (const v of [
        it.payload.cwd,
        it.payload.workspace?.project_dir,
        it.payload.workspace?.current_dir,
      ]) {
        if (typeof v === "string") paths.push(v);
      }
    }
  }
  const hookEvents = new Map([...byEvent].filter(([ev]) => !STATUS_DIRS.has(ev)));
  const mapper = new Mapper();
  mapper.seedProjects(paths.sort());
  const scrubber = new Scrubber(mapper);

  const picks = [
    ...[...hookEvents].flatMap(([ev, items]) => pickHookGroups(ev, items)),
    ...pickExtras(hookEvents),
    ...(hookEvents.get("PermissionRequest") ?? []).map((item) => ({
      dir: "PermissionRequest",
      tag: "",
      item,
    })),
    ...pickStatusLine(
      byEvent.get("statusLine") ?? [],
      hookEvents.get("PostCompact") ?? [],
      STATUS_WANT,
    ),
    ...pickSubagentStatus(byEvent.get("subagentStatusLine") ?? [], SUBAGENT_WANT),
  ];
  // Dedupe by source file; the later pick wins, so an extra's tag (interrupted, after-ask) replaces
  // the untagged group pick. Then order for stable numbering.
  const unique = [...new Map(picks.map((p) => [`${p.dir}/${p.item.file}`, p])).values()];
  unique.sort((a, b) =>
    a.dir < b.dir
      ? -1
      : a.dir > b.dir
        ? 1
        : a.item.epoch - b.item.epoch || (a.item.file < b.item.file ? -1 : 1),
  );

  for (const dir of new Set([...unique.map((p) => p.dir), ...OWNED])) clean(join(out, dir));
  const counters = new Map();
  for (const p of unique) {
    const scrubbed = /** @type {any} */ (scrubber.value(p.item.payload));
    const n = (counters.get(p.dir) ?? 0) + 1;
    counters.set(p.dir, n);
    const name = `${String(n).padStart(2, "0")}-${nameSlug(scrubbed, p.tag)}.json`;
    write(join(out, p.dir, name), `${JSON.stringify(scrubbed, null, 2)}\n`);
  }

  const golden = pickGolden(hookEvents, GOLDEN_MAX_EVENTS);
  if (golden) {
    const lines = golden.events.map((e) => JSON.stringify(scrubber.value(e.item.payload)));
    write(join(out, "sessions", "golden-session.jsonl"), `${lines.join("\n")}\n`);
  }

  const template = /** @type {any} */ (
    scrubber.value((hookEvents.get("UserPromptSubmit") ?? [])[0]?.payload ?? {})
  );
  for (const s of buildSynthetic(template)) {
    write(join(out, "synthetic", s.event, s.file), `${JSON.stringify(s.payload, null, 2)}\n`);
  }

  const summary = [...counters].map(([d, n]) => `${d}=${n}`).join(" ");
  console.log(`written: ${summary}`);
  console.log(`golden events: ${golden ? golden.events.length : 0}`);
  console.log(`projects mapped: ${mapper.projects.size}`);
  const denied = [...scrubber.denied].sort((a, b) => b[1] - a[1]);
  console.log(`placeholder paths (${denied.length}), key path: strings replaced`);
  for (const [path, n] of denied) console.log(`  ${path}: ${n}`);
  const unknown = [...scrubber.unknownKeys].sort();
  if (unknown.length > 0) {
    console.error(
      `UNKNOWN KEYS (${unknown.length} paths): review, then add to lib/fixture-keys.mjs`,
    );
    for (const [path, n] of unknown) console.error(`  ${path}: ${n}`);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(`fixture-scrub: ${error instanceof Error ? error.message : "failed"}`);
  process.exit(1);
}
