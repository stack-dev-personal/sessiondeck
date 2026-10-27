// Transcript scrub driver (R0.7, transcript extension): raw/transcripts/<NN-slug>/ ->
// <out>/transcripts/<NN-slug>/. Counts only on stdout; never values.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Mapper } from "./fixture-scrub-paths.mjs";
import { TranscriptScrubber } from "./transcript-scrub-core.mjs";
import { discoverLiterals } from "./transcript-scrub-literals.mjs";
import { renderReadme } from "./transcript-scrub-readme.mjs";

const AGENT_FILE = /^agent-[A-Za-z0-9_-]{4,64}\.(?:jsonl|meta\.json)$/;
const FIXTURE_DIR = /^\d{2}-[a-z0-9-]{1,40}$/;

/** @param {string} p @returns {unknown[]} */
function readRows(p) {
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

/** @param {Map<string, number>} m @param {string} k */
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

/** @param {any} row @param {import("./transcript-scrub-readme.mjs").FixtureStats} st */
function tally(row, st) {
  const type = typeof row?.type === "string" ? row.type : "<none>";
  bump(st.types, type);
  if (type === "system" && typeof row.subtype === "string") bump(st.subtypes, row.subtype);
  if (type === "attachment" && typeof row.attachment?.type === "string") {
    bump(st.attachments, row.attachment.type);
  }
  const content = row?.message?.content;
  const role = typeof row?.message?.role === "string" ? row.message.role : "none";
  if (Array.isArray(content)) {
    for (const b of content) bump(st.blocks, `${type}/${role}/${b?.type ?? "<none>"}`);
  } else if (typeof content === "string") bump(st.blocks, `${type}/${role}/string`);
  if (typeof row?.version === "string" && /^\d+\.\d+\.\d+/.test(row.version)) {
    st.versions.add(row.version);
  }
}

/**
 * Lists the files of one raw fixture in the fixed order: session.jsonl, then subagents sorted.
 * @param {string} dir
 */
function listFiles(dir) {
  const files = [{ rel: "session.jsonl", jsonl: true }];
  const sub = join(dir, "subagents");
  if (existsSync(sub)) {
    for (const n of readdirSync(sub).sort()) {
      if (!AGENT_FILE.test(n)) throw new Error("unexpected file name in subagents");
      files.push({ rel: `subagents/${n}`, jsonl: n.endsWith(".jsonl") });
    }
  }
  return files;
}

/**
 * @param {string} rawDir @param {string} outDir @param {string} name
 * @param {import("./transcript-scrub-text.mjs").Literals} literals
 */
export function scrubFixture(rawDir, outDir, name, literals) {
  const files = listFiles(rawDir);
  /** @type {Map<string, unknown[]>} */
  const parsed = new Map();
  const cwds = [];
  for (const f of files) {
    const p = join(rawDir, f.rel);
    const rows = f.jsonl ? readRows(p) : [JSON.parse(readFileSync(p, "utf8"))];
    parsed.set(f.rel, rows);
    for (const r of rows)
      if (typeof (/** @type {any} */ (r)?.cwd) === "string") cwds.push(/** @type {any} */ (r).cwd);
  }
  const mapper = new Mapper();
  mapper.seedProjects(cwds.sort());
  const scrubber = new TranscriptScrubber({ mapper, literals });
  /** @type {import("./transcript-scrub-readme.mjs").FixtureStats} */
  const st = {
    rows: 0,
    files: files.length,
    perFile: [],
    srcBytes: 0,
    outBytes: 0,
    types: new Map(),
    subtypes: new Map(),
    attachments: new Map(),
    blocks: new Map(),
    versions: new Set(),
    dropped: scrubber.dropped,
    denied: scrubber.denied,
  };
  const hash = createHash("sha256");
  for (const f of files) {
    const rows = parsed.get(f.rel) ?? [];
    const out = rows.map((r) => scrubber.row(r));
    for (const r of out) if (f.jsonl) tally(r, st);
    const body = f.jsonl
      ? `${out.map((r) => JSON.stringify(r)).join("\n")}\n`
      : `${JSON.stringify(out[0], null, 2)}\n`;
    const dest = join(outDir, name, f.rel);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, body, "utf8");
    if (f.jsonl) {
      st.rows += out.length;
      st.perFile.push({ rel: f.rel, rows: out.length });
    }
    st.srcBytes += statBytes(join(rawDir, f.rel));
    st.outBytes += Buffer.byteLength(body);
    hash.update(`${f.rel}\n${body}`);
  }
  writeFileSync(join(outDir, name, "README.md"), renderReadme(st, name, files.length > 1), "utf8");
  return { st, scrubber, digest: hash.digest("hex"), mapper };
}

/** @param {string} p */
const statBytes = (p) => readFileSync(p).length;

/**
 * Scrubs every fixture under <raw>/transcripts into <out>/transcripts.
 * @param {string} raw @param {string} out
 * @returns {number} exit code
 */
export function runTranscripts(raw, out) {
  const root = join(raw, "transcripts");
  if (!existsSync(root)) throw new Error("raw transcripts directory not found");
  const names = readdirSync(root)
    .filter((n) => FIXTURE_DIR.test(n))
    .sort();
  const all = [];
  for (const n of names)
    for (const f of listFiles(join(root, n))) {
      const p = join(root, n, f.rel);
      all.push(...(f.jsonl ? readRows(p) : [JSON.parse(readFileSync(p, "utf8"))]));
    }
  const literals = discoverLiterals(all);
  console.log(
    `literals: users ${literals.users.length}, emails ${literals.emails.length}, accounts ${literals.accounts.length}, fragments ${literals.fragments.length}`,
  );
  let unknown = 0;
  let fragmentHits = 0;
  for (const n of names) {
    const r = scrubFixture(join(root, n), join(out, "transcripts"), n, literals);
    console.log(
      `${n}: rows ${r.st.rows}, files ${r.st.files}, src ${r.st.srcBytes}, out ${r.st.outBytes}, sha256 ${r.digest.slice(0, 16)}`,
    );
    fragmentHits += r.scrubber.text.fragmentHits;
    for (const [path, c] of [...r.scrubber.unknownKeys].sort()) {
      console.error(`UNKNOWN KEY ${n} ${path}: ${c}`);
      unknown += 1;
    }
  }
  console.log(`fragment replacements: ${fragmentHits}`);
  if (unknown > 0)
    console.error(`UNKNOWN KEYS (${unknown} paths): review, then add to lib/fixture-keys.mjs`);
  return unknown > 0 ? 1 : 0;
}
