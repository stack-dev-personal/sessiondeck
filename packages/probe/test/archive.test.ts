import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArchiveEnvelopeSchema, ArchivePayloadSchema } from "@sessiondeck/contract";
import { parseFrontmatter } from "../src/archive/frontmatter.ts";
import { ArchiveImporter, archiveEnvelopeId } from "../src/archive/importer.ts";
import { normalizeCapture } from "../src/archive/normalize.ts";
import { redactText } from "../src/archive/redact.ts";
import { ArchiveComponent } from "../src/daemon/archive.ts";
import { MAX_BODY_BYTES } from "../src/daemon/forwarder.ts";
import { defaultComponents } from "../src/daemon/components.ts";
import { startDaemon } from "../src/daemon/index.ts";
import { buildEnvelope } from "../src/envelope.ts";
import { outboxDir, spoolDir } from "../src/paths.ts";
import { createOutbox } from "../src/daemon/outbox.ts";
import { appendSpoolLines } from "../src/spool-writer.ts";
import {
  ConfigError,
  readConfig,
  validateArchiveConfig,
  writeConfig,
} from "../src/config/config.ts";
import type { SpoolLine } from "../src/spool-format.ts";
import { fixturesDir } from "./helpers.ts";

const vault = join(fixturesDir, "vault");
const edge = join(fixturesDir, "vault-edge");
const tmps: string[] = [];
afterEach(async () => {
  for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "sd-archive-"));
  tmps.push(d);
  return d;
}

async function walk(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const r = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...(await walk(dir, r)));
    else out.push(r);
  }
  return out;
}

async function fixtureFiles(): Promise<string[]> {
  return (await walk(vault)).filter((p) => /^(projects|harness)\/.+\/sessions\/.+\.md$/.test(p));
}

describe("golden fixtures", () => {
  it("normalizes all 22 captures to the goldens", async () => {
    const files = await fixtureFiles();
    expect(files).toHaveLength(22);
    for (const rel of files) {
      const text = await readFile(join(vault, rel), "utf8");
      const golden = JSON.parse(await readFile(join(vault, "expected", `${rel}.json`), "utf8"));
      const res = normalizeCapture({ text, rootLabel: "vault", relPath: rel, mtimeMs: 1, size: 2 });
      expect(res.ok, rel).toBe(true);
      if (!res.ok) continue;
      expect(ArchivePayloadSchema.safeParse(res.payload).success).toBe(true);
      const source = {
        root_label: res.payload.source.root_label,
        rel_path: res.payload.source.rel_path,
      };
      expect({ ...res.payload, source }, rel).toEqual(golden);
    }
  });

  it("skips the edge fixtures with the expected reasons", async () => {
    const dir = "harness/agentic-harness/sessions";
    const run = async (name: string) =>
      normalizeCapture({
        text: await readFile(join(edge, dir, name), "utf8"),
        rootLabel: "vault",
        relPath: `${dir}/${name}`,
        mtimeMs: 1,
        size: 1,
      });
    expect(await run("no-frontmatter.md")).toEqual({ ok: false, reason: "no_frontmatter" });
    expect(await run("no-session-id.md")).toEqual({ ok: false, reason: "no_session_id" });
    expect(await run("unterminated.md")).toEqual({ ok: false, reason: "unterminated_frontmatter" });
    const big = await run("oversized-outcome.md");
    expect(big.ok).toBe(true);
    if (big.ok) {
      expect(big.payload.outcome).toHaveLength(16384);
      expect(big.payload.outcome_truncated).toBe(true);
    }
  });

  it("turns bad dates and durations into null instead of failing", () => {
    const text =
      "---\nsession_id: abc\ndate: 2026-13-45\nstarted_at: nonsense\nduration: soon\n---\nbody";
    const res = normalizeCapture({
      text,
      rootLabel: "v",
      relPath: "projects/p/sessions/a.md",
      mtimeMs: 0,
      size: 0,
    });
    expect(res.ok && res.payload.date).toBeNull();
    expect(res.ok && res.payload.started_at).toBeNull();
    expect(res.ok && res.payload.duration_s).toBeNull();
  });

  it("rejects an unsafe rel path", () => {
    const r = normalizeCapture({
      text: "---\nsession_id: a\n---\n",
      rootLabel: "v",
      relPath: "projects/p/sessions/CON.md",
      mtimeMs: 0,
      size: 0,
    });
    expect(r).toEqual({ ok: false, reason: "bad_rel_path" });
  });
});

describe("frontmatter parser", () => {
  it("handles the supported subset", () => {
    const r = parseFrontmatter(
      "\uFEFF---\r\na: 1\r\nb: 'it''s'\r\nc: \"x\\ty\\u0041\"\r\nd: [1, 'two', {k: v}]\r\ne:\r\n  - x: 1\r\n  - y\r\nf: true # c\r\ng: ~\r\nh: 2026-09-01\r\ni: |\r\n  line1\r\n  line2\r\n---\r\nbody\r\n",
    );
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect({ ...r.data }).toEqual({
      a: 1,
      b: "it's",
      c: "x\tyA",
      d: [1, "two", { k: "v" }],
      e: [{ x: 1 }, "y"],
      f: true,
      g: null,
      h: "2026-09-01",
      i: "line1\nline2\n",
    });
    expect(r.body).toBe("body\n");
  });

  it("reports unsupported constructs as skipped", () => {
    for (const bad of ["a: &x 1", "a: *x", "a: !!str 1", "a: 'unterminated", "a: [1, 2"]) {
      const r = parseFrontmatter(`---\n${bad}\n---\n`);
      expect(r.kind, bad).toBe("skip");
    }
    expect(parseFrontmatter("---\n- a\n---\n")).toEqual({
      kind: "skip",
      reason: "frontmatter_not_map",
    });
  });

  it("survives hostile input quickly", () => {
    const cases = [
      `---\na: ${"[".repeat(100000)}\n---\n`,
      `---\na: ${"{a:".repeat(50000)}\n---\n`,
      `---\n${Array.from({ length: 200 }, (_, i) => `${" ".repeat(i * 2)}k${i}:`).join("\n")}\n---\n`,
      `---\n${Array.from({ length: 200 }, (_, i) => `${" ".repeat(i * 2)}-`).join("\n")}\n---\n`,
      `---\na: ${"x".repeat(1_000_000)}\n---\n`,
      `---\na: '${"'".repeat(500_000)}\n---\n`,
      `---\n${"a: 1\n".repeat(4000)}---\n`,
      `---\n${"- ".repeat(100000)}\n---\n`,
    ];
    const t0 = performance.now();
    for (const c of cases) expect(() => parseFrontmatter(c)).not.toThrow();
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

// Secrets are built from parts so this file does not itself look like a leak to scanners.
const secrets = {
  sk: "s" + "k-" + "a1".repeat(16),
  ant: "s" + "k-ant-" + "Ab3".repeat(10),
  ghp: "gh" + "p_" + "x".repeat(36),
  gho: "gh" + "o_" + "y".repeat(36),
  pat: "github" + "_pat_" + "z".repeat(30),
  slack: "xo" + "xb-" + "1234567890-abcdef",
  aws: "AK" + "IA" + "ABCDEFGHIJKLMNOP",
  jwt: ["ey" + "Jhbgci", "ey" + "Jzdwii", "sig" + "nature12"].join("."),
};

describe("redaction", () => {
  it.each(Object.entries(secrets))("masks a %s token", (_n, v) => {
    const out = redactText(`before ${v} after`);
    expect(out).toBe("before [REDACTED] after");
  });

  it("masks bearer tokens, PEM blocks and env-style lines", () => {
    expect(redactText("Authorization: Bearer abc123def456ghi")).toBe("Authorization: [REDACTED]");
    const pem =
      "-----BEGIN RSA PRIVATE" + " KEY-----\nMIIB\nabc\n-----END RSA PRIVATE" + " KEY-----";
    expect(redactText(`k:\n${pem}\ndone`)).toBe("k:\n[REDACTED]\ndone");
    expect(redactText("-----BEGIN PRIVATE" + " KEY-----\nMIIB-unterminated")).toBe("[REDACTED]");
    expect(redactText("MY_API_KEY=hunter2 and more")).toBe("MY_API_KEY=[REDACTED]");
    expect(redactText("db_password: hunter2")).toBe("db_password: [REDACTED]");
    expect(redactText('{"client_secret": "abc def"}')).toBe('{"client_secret": [REDACTED]}');
    expect(redactText("AUTH_TOKEN=a\nOTHER=b")).toBe("AUTH_TOKEN=[REDACTED]\nOTHER=b");
    expect(redactText("plain text, nothing here")).toBe("plain text, nothing here");
  });

  it("pass ordering: CLI flags and UPPER_ENV do not consume the next assignment (U2 LOW)", () => {
    expect(redactText("run --password = hunter2")).toBe("run --password = [REDACTED]");
    expect(redactText("X_TOKEN api_key: hunter2")).toBe("X_TOKEN [REDACTED]");
    expect(redactText("--token api_key=hunter2")).toBe("--token [REDACTED]");
    expect(redactText("PGPASSWORD hunter2")).toBe("PGPASSWORD [REDACTED]");
    expect(redactText("--password hunter2")).toBe("--password [REDACTED]");
  });

  it("archive envelope ids are deterministic per capture content (review iteration 1)", () => {
    const p = { source: { mtime_ms: 1_790_000_000_000 }, title: "a" };
    const id = archiveEnvelopeId(p);
    expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(archiveEnvelopeId({ ...p })).toBe(id);
    expect(archiveEnvelopeId({ ...p, title: "b" })).not.toBe(id);
  });

  it("quoted and name:value CLI values are masked whole (review iteration 1)", () => {
    expect(redactText('--password "pass: correct horse battery"')).toBe("--password [REDACTED]");
    expect(redactText('--password "token: abc def"')).toBe("--password [REDACTED]");
    expect(redactText('MY_TOKEN "apikey: hunter2 hunter3"')).toBe("MY_TOKEN [REDACTED]");
    expect(redactText("--password token:Hunter2xyz")).toBe("--password [REDACTED]");
    expect(redactText("--password token:Hunter2xyz")).not.toContain("Hunter2xyz");
  });

  it("block scalar heads accept a comment, a YAML tag and a quoted key (U2 LOW)", () => {
    for (const head of [
      "password: | # keep secret",
      "password: !!str |",
      "password: &a !tag >-  # c",
      '"password": |',
      "- 'api_key': |+2",
    ]) {
      const out = redactText(`top\n${head}\n  line1\n  line2\nnext: ok`);
      expect(out).not.toContain("line1");
      expect(out).not.toContain("line2");
      expect(out).toContain("[REDACTED]");
      expect(out.endsWith("\nnext: ok")).toBe(true);
    }
  });

  it("is fast on adversarial input", () => {
    const t0 = performance.now();
    redactText("eyJ".repeat(30000));
    redactText('TOKEN: "'.repeat(8000));
    redactText("a".repeat(1_000_000));
    redactText("-----BEGIN PRIVATE KEY-----".repeat(2000));
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("redacts outcome, title, commits and prs of a payload", () => {
    const text = `---\nsession_id: s1\ntitle: "rotate ${secrets.ghp}"\ncommits:\n  - "fix ${secrets.sk}"\nprs: ["API_KEY=zzz"]\n---\nUsed ${secrets.aws} here`;
    const r = normalizeCapture({
      text,
      rootLabel: "v",
      relPath: "projects/p/sessions/a.md",
      mtimeMs: 0,
      size: 0,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const all = JSON.stringify(r.payload);
    for (const v of Object.values(secrets)) expect(all).not.toContain(v);
    expect(r.payload.title).toBe("rotate [REDACTED]");
    expect(r.payload.prs).toEqual(["API_KEY=[REDACTED]"]);
  });
});

interface Sink {
  lines: SpoolLine[];
  enqueue: (l: SpoolLine) => void;
}
function sink(): Sink {
  const lines: SpoolLine[] = [];
  return { lines, enqueue: (l) => void lines.push(l) };
}

async function setup(): Promise<{ root: string; state: string }> {
  const d = await tmp();
  const root = join(d, "vault");
  await cp(vault, root, { recursive: true });
  await rm(join(root, "expected"), { recursive: true });
  await rm(join(root, "README.md"));
  return { root, state: join(d, "home", "daemon", "archive-index.json") };
}

function importer(
  root: string,
  state: string,
  s: Sink,
  extra: Partial<ConstructorParameters<typeof ArchiveImporter>[0]> = {},
) {
  return new ArchiveImporter({
    roots: [{ label: "vault", path: root }],
    statePath: state,
    host: "h",
    enqueue: s.enqueue,
    ...extra,
  });
}

describe("redaction differential (review iteration 2)", () => {
  // Every input here was fully masked by f00fd4e; the secret must stay out of the output.
  const SECRETS = ["Hunter2Zq9", "b c", "tail9Zq"];
  const cases = [
    "--password Hunter2Zq9secret:",
    "PGPASSWORD Hunter2Zq9token=",
    "--api-key Hunter2Zq9_pass=x",
    "--db-secret Hunter2Zq9secret: more",
    '--password "pass:"Hunter2Zq9',
    "--password `pass: Hunter2Zq9`",
    "--token \u201Ca b c\u201D",
    "--api-key token :Hunter2Zq9",
    "--api-key token : Hunter2Zq9",
    "--password \u2018pass: Hunter2Zq9\u2019",
    "--password = Hunter2Zq9",
    "X_TOKEN api_key: Hunter2Zq9",
    "--token api_key=Hunter2Zq9",
    '--password "unclosed Hunter2Zq9',
    "--secret Hunter2Zq9:x",
  ];
  it.each(cases)("%s", (input) => {
    const out = redactText(input);
    for (const sec of SECRETS) expect(out).not.toContain(sec);
    expect(out).toContain("[REDACTED]");
  });
  it("does not swallow a following flag after an ordinary value", () => {
    expect(redactText("--password a --token b --verbose")).toBe(
      "--password [REDACTED] --token [REDACTED] --verbose",
    );
  });
});

describe("importer", () => {
  it("uses archiveEnvelopeId: same capture, same id; another host, another id (review iteration 2)", async () => {
    const a = await setup();
    const s1 = sink();
    const s2 = sink();
    const s3 = sink();
    await importer(a.root, a.state, s1).scan();
    await importer(a.root, a.state + ".2", s2).scan();
    await importer(a.root, a.state + ".3", s3, { host: "other" }).scan();
    const ids = (s: Sink) => s.lines.map((l) => l.id).sort();
    expect(ids(s1)).toEqual(ids(s2));
    expect(ids(s3)).not.toEqual(ids(s1));
    expect(ids(s3).some((i) => ids(s1).includes(i))).toBe(false);
    for (const i of ids(s3)) expect(i).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });

  it("is idempotent and incremental", async () => {
    const { root, state } = await setup();
    const s = sink();
    const imp = importer(root, state, s);
    const r1 = await imp.scan();
    expect(r1.shipped).toBe(22);
    expect(s.lines).toHaveLength(22);
    for (const l of s.lines) {
      expect(l.kind).toBe("archive");
      expect(ArchiveEnvelopeSchema.safeParse({ ...l, seq: 0 }).success).toBe(true);
    }
    const r2 = await imp.scan();
    expect(r2.shipped).toBe(0);
    expect(r2.unchanged).toBe(22);
    // A fresh importer (daemon restart) reads the persisted index.
    const r2b = await importer(root, state, s).scan();
    expect(r2b.shipped).toBe(0);
    expect(s.lines).toHaveLength(22);

    const f = join(root, "harness/agentic-harness/sessions/2026-09-01-0900-probe-spool.md");
    await utimes(f, new Date(), new Date(Date.now() + 5000));
    expect((await imp.scan()).shipped).toBe(1);
    expect(s.lines).toHaveLength(23);

    await rm(f);
    const r4 = await imp.scan();
    expect(r4.shipped).toBe(0);
    expect(r4.dropped).toBe(1);
    const idx = JSON.parse(await readFile(state, "utf8")) as { entries: Record<string, unknown> };
    expect(Object.keys(idx.entries)).toHaveLength(21);
    expect(
      Object.keys(idx.entries).every(
        (k) => k.startsWith("vault:harness/") || k.startsWith("vault:projects/"),
      ),
    ).toBe(true);
  });

  it("ships only unindexed files after an enqueue failure", async () => {
    const { root, state } = await setup();
    const shipped: string[] = [];
    let n = 0;
    const flaky = importer(root, state, sink(), {
      concurrency: 1,
      enqueue: (l) => {
        if (++n === 10) return Promise.reject(new Error("disk full"));
        shipped.push(l.session_id as string);
        return Promise.resolve();
      },
    });
    const r1 = await flaky.scan();
    expect(r1.failed).toBe(1);
    expect(r1.shipped).toBe(9);
    const s = sink();
    const r2 = await importer(root, state, s).scan();
    expect(r2.shipped).toBe(13);
    const again = new Set(s.lines.map((l) => l.session_id as string));
    expect(shipped.some((id) => again.has(id))).toBe(false);
    expect(new Set([...shipped, ...again]).size).toBe(22);
  });

  it("does not re-read skipped files that did not change, and counts reasons", async () => {
    const { root, state } = await setup();
    const dir = join(root, "harness/agentic-harness/sessions");
    for (const f of [
      "no-frontmatter.md",
      "no-session-id.md",
      "unterminated.md",
      "oversized-outcome.md",
    ]) {
      await cp(join(edge, "harness/agentic-harness/sessions", f), join(dir, f));
    }
    await writeFile(join(dir, "notes.txt"), "ignored");
    const s = sink();
    const imp = importer(root, state, s);
    const r1 = await imp.scan();
    expect(r1.shipped).toBe(23);
    expect(r1.skipped).toEqual({
      no_frontmatter: 1,
      no_session_id: 1,
      unterminated_frontmatter: 1,
    });
    const r2 = await imp.scan();
    expect(r2.shipped).toBe(0);
    expect(r2.skipped).toEqual(r1.skipped);
  });

  it("skips oversized files, symlinks and unsafe names", async () => {
    const { root, state } = await setup();
    const dir = join(root, "harness/agentic-harness/sessions");
    await writeFile(
      join(dir, "big.md"),
      `---\nsession_id: big\n---\n${"x".repeat(2 * 1024 * 1024)}`,
    );
    await writeFile(join(dir, "bad:name.md"), "---\nsession_id: colon\n---\n");
    await writeFile(join(dir, "CON.md"), "---\nsession_id: con\n---\n");
    let linked = false;
    try {
      await symlink(
        join(root, "projects/sessiondeck/sessions/2026-09-11-1000-web-shell.md"),
        join(dir, "link.md"),
      );
      linked = true;
    } catch {
      // Symlinks need privileges on Windows; the rest of the test still runs.
    }
    const s = sink();
    const r = await importer(root, state, s).scan();
    expect(r.shipped).toBe(22);
    expect(r.skipped["too_large"]).toBe(1);
    expect(r.skipped["bad_rel_path"]).toBeGreaterThanOrEqual(1);
    if (linked) expect(r.skipped["symlink"]).toBe(1);
    expect(s.lines.map((l) => l.session_id)).not.toContain("big");
  });

  it("never writes into the vault and keeps the index when a directory is unreadable", async () => {
    const { root, state } = await setup();
    const before = (await walk(root)).sort();
    const s = sink();
    const imp = importer(root, state, s);
    await imp.scan();
    expect((await walk(root)).sort()).toEqual(before);
    // A missing root must not wipe the index.
    await rm(root, { recursive: true });
    const r = await imp.scan();
    expect(r.dropped).toBe(0);
    expect(r.skipped["root_missing"]).toBe(1);
    const idx = JSON.parse(await readFile(state, "utf8")) as { entries: Record<string, unknown> };
    expect(Object.keys(idx.entries)).toHaveLength(22);
  });

  it("re-ships when the index is corrupt", async () => {
    const { root, state } = await setup();
    await mkdir(join(state, ".."), { recursive: true });
    await writeFile(state, "{not json");
    const s = sink();
    expect((await importer(root, state, s).scan()).shipped).toBe(22);
  });
});

describe("daemon component", () => {
  it("scans on start, does not overlap, and stops", async () => {
    const { root, state } = await setup();
    const s = sink();
    const logs: string[] = [];
    const c = new ArchiveComponent({
      config: { roots: [{ label: "vault", path: root }] },
      statePath: state,
      initialDelayMs: 0,
      intervalMs: 20,
    });
    c.start({ home: "x", host: "h", log: (_l, m) => void logs.push(m), enqueue: s.enqueue });
    const [a, b] = await Promise.all([c.runOnce(), c.runOnce()]);
    expect(a).toBe(b);
    await new Promise((r) => setTimeout(r, 100));
    await c.stop();
    expect(s.lines).toHaveLength(22);
    const n = logs.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(logs.length).toBe(n);
    expect(logs.some((m) => m.startsWith("archive scan"))).toBe(true);
  });
});

describe("archive config", () => {
  const abs = join(tmpdir(), "vault");
  it("accepts a valid block", () => {
    expect(
      validateArchiveConfig({ roots: [{ label: "main", path: abs }], intervalSec: 60 }),
    ).toEqual({
      roots: [{ label: "main", path: abs }],
      intervalSec: 60,
    });
    expect(validateArchiveConfig({ roots: [] })).toEqual({ roots: [] });
  });
  it.each([
    ["not an object", []],
    ["unknown key", { roots: [], extra: 1 }],
    ["roots missing", {}],
    ["bad label", { roots: [{ label: "../x", path: abs }] }],
    ["relative path", { roots: [{ label: "a", path: "vault/rel" }] }],
    ["extra root key", { roots: [{ label: "a", path: abs, x: 1 }] }],
    [
      "duplicate label",
      {
        roots: [
          { label: "a", path: abs },
          { label: "A", path: abs },
        ],
      },
    ],
    ["interval too small", { roots: [], intervalSec: 5 }],
    ["interval not a number", { roots: [], intervalSec: "60" }],
  ])("rejects %s", (_n, raw) => {
    expect(() => validateArchiveConfig(raw)).toThrow(ConfigError);
  });

  it("round-trips through probe.json", async () => {
    const d = await tmp();
    const p = join(d, "probe.json");
    await writeConfig(p, { host: "h", archive: { roots: [{ label: "main", path: abs }] } });
    expect((await readConfig(p))?.archive).toEqual({ roots: [{ label: "main", path: abs }] });
    await writeFile(
      p,
      JSON.stringify({ host: "h", archive: { roots: [{ label: "x", path: "rel" }] } }),
    );
    // An invalid block no longer fails the read: hub settings survive, the importer is off, and
    // the raw block is kept so a rewrite does not delete it.
    const bad = await readConfig(p);
    expect(bad?.host).toBe("h");
    expect(bad?.archive).toBeUndefined();
    expect(bad?.archiveError).toMatch(/absolute/);
    await writeConfig(p, bad!);
    expect((JSON.parse(await readFile(p, "utf8")) as { archive: unknown }).archive).toEqual({
      roots: [{ label: "x", path: "rel" }],
    });
  });
});

// Secrets are assembled at runtime so scanners do not flag literals in this file.
const j = (...p: string[]): string => p.join("");

describe("redaction coverage (R5.2)", () => {
  it("a value that names a secret followed by an `=` masks the rest of the line (U4b)", () => {
    const cases: [string, string[]][] = [
      ["--api-key= db_pass= x x=S", ["S", "x=S"]],
      ['--api-key= "secret" = S', ["= S"]],
      ["--api-key= passphrase = correct S", ["correct", " S"]],
      ['--api-key\tXsecret: =token ="S"', ['"S"', "=token"]],
      ["MY_SECRET \"secret\"'token': S= :x", ["S=", ":x"]],
    ];
    for (const [input, gone] of cases) {
      const out = redactText(input);
      expect(out).toContain("[REDACTED]");
      for (const g of gone) expect(out, input).not.toContain(g);
    }
    expect(redactText("--api-key= db_pass= x x=S\nnext line")).toBe(
      "--api-key= [REDACTED]\nnext line",
    );
  });

  it("a dash-led token after a `name:` value is masked (safe failure, U4b)", () => {
    expect(redactText("--password token: --verbose and more prose")).not.toContain("--verbose");
    expect(redactText("--api-key token: -Hunter2Zq9")).not.toContain("Hunter2Zq9");
  });
  const dashLeads = ["-S", "--S", "-S=", '-"S"', "-'S"];
  const nameVals = ["token:", "secret:", "db_pass:", '"token":', "token :"];
  const slots = ["--api-key", "--password", "MY_API_KEY"];
  it("no dash-led secret survives after a name value (U4b)", () => {
    for (const sl of slots)
      for (const nv of nameVals)
        for (const d of dashLeads) {
          const input = `${sl} ${nv} ${d.replace(/S/, "Hunter2Zq9")}`;
          expect(redactText(input), input).not.toContain("Hunter2Zq9");
        }
  });
  it("keeps the CR of a CRLF line when masking to end of line (U4b)", () => {
    expect(redactText("--api-key= db_pass= x x=S\r\nnext line")).toBe(
      "--api-key= [REDACTED]\r\nnext line",
    );
  });
  const pw = j("S3cr3t", "Pw99");
  const cases: Array<[string, string]> = [
    ["https url", `clone https://alice:${pw}@git.example.com/x.git now`],
    ["postgres url", `fixed DATABASE_URL postgres://app:${pw}@prod-db:5432/x`],
    ["srv url", `mongodb+srv://u:${pw}@cluster0.example.net/db`],
    ["basic auth", `Authorization: Basic ${j("dXNlcjpw", "YXNzd29yZA==")}`],
    ["stripe live", `key ${j("sk_", "live_", "A1b2C3d4E5f6G7h8")}`],
    ["stripe restricted", `key ${j("rk_", "live_", "A1b2C3d4E5f6G7h8")}`],
    ["google key", `key ${j("AI", "zaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6")}`],
    ["npm token", `//registry/:_authToken=${j("npm", "_", "a".repeat(36))}`],
    ["gitlab pat", `token ${j("glpat", "-", "A1b2C3d4E5f6G7h8I9j0")}`],
    ["db_pass", `db_pass=${pw}`],
    ["pwd key", `PWD: ${pw}`],
    ["json password", `{"password": "${pw}"}`],
    ["next line value", `token:\n  ${pw}\nrest`],
    ["camel apiKey", `apiKey: ${pw}`],
    ["access token", `accessToken=${pw}`],
    ["empty-user url", `redis://:${pw}@redis:6379`],
    ["at in url password", `postgres://app:${j("p@ss", "/w0rd")}${pw}@db/x`],
    ["folded scalar", `secret: >-\n  folded ${pw}\nnext: 1`],
    ["literal scalar", `secret: |\n  line1 ${pw}\n\n  line2 ${pw}\nnext: 1`],
    ["curl -u", `curl -u admin:${pw} https://x`],
    ["--password sep", `run --password ${pw} --verbose`],
    ["--token=", `run --token=${pw}`],
    ["--api-key", `run --api-key ${pw}`],
    ["set PGPASSWORD", `set PGPASSWORD ${pw}`],
  ];
  it.each(cases)("masks %s", (_n, input) => {
    const out = redactText(input);
    expect(out).not.toContain(pw);
    expect(out).not.toMatch(/A1b2C3d4E5f6G7h8|dXNlcjpw|aaaaaaaaaaaa/);
    expect(out).toContain("[REDACTED]");
  });
  it("keeps structure around block scalars and flags", () => {
    expect(redactText("secret: |\n  a\n  b\nnext: 1")).toBe("secret: [REDACTED]\nnext: 1");
    expect(redactText("run --password x --verbose")).toBe("run --password [REDACTED] --verbose");
  });
  it("keeps the user and host of a credentialed url", () => {
    expect(redactText(`postgres://app:${pw}@prod-db:5432/x`)).toBe(
      "postgres://app:[REDACTED]@prod-db:5432/x",
    );
  });
  it("leaves ordinary prose and plain urls alone", () => {
    for (const t of [
      "tokens: 1200 in, 300 out",
      "the secretary: Bob joined",
      "bypass: the cache; compass: north",
      "a basic understanding of the password reset flow",
      "see https://example.com:8080/path and ssh://git@host/repo",
      "Passing arguments: none",
      "the password was rotated; pass --token-count 5 and -u later",
      "PASSWORD RESET and TOKEN LIMIT are words",
    ]) {
      expect(redactText(t), t).toBe(t);
    }
  });
});

describe("importer hardening (R5.2)", () => {
  async function linkOrSkip(target: string, at: string): Promise<boolean> {
    try {
      await symlink(target, at, "junction");
      return true;
    } catch {
      return false;
    }
  }

  it("refuses a sessions directory that is a link and never ships outside the vault", async () => {
    const { root, state } = await setup();
    const outside = join(await tmp(), "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "x.md"), "---\nsession_id: outside-1\n---\nleak");
    await rm(join(root, "projects/sessiondeck/sessions"), { recursive: true });
    if (!(await linkOrSkip(outside, join(root, "projects/sessiondeck/sessions")))) return;
    const s = sink();
    const r = await importer(root, state, s).scan();
    expect(r.skipped["symlink"]).toBe(1);
    expect(s.lines.map((l) => l.session_id)).not.toContain("outside-1");
  });

  it("refuses linked project directories and counts them", async () => {
    const { root, state } = await setup();
    const outside = join(await tmp(), "p");
    await mkdir(join(outside, "sessions"), { recursive: true });
    await writeFile(join(outside, "sessions/x.md"), "---\nsession_id: outside-2\n---\nleak");
    if (!(await linkOrSkip(outside, join(root, "projects/linked")))) return;
    const s = sink();
    const r = await importer(root, state, s).scan();
    expect(r.skipped["symlink"]).toBe(1);
    expect(s.lines.map((l) => l.session_id)).not.toContain("outside-2");
  });

  it("accepts a configured root that is itself a link", async () => {
    const { root, state } = await setup();
    const link = join(await tmp(), "vault-link");
    if (!(await linkOrSkip(root, link))) return;
    const s = sink();
    const r = await importer(link, state, s).scan();
    expect(r.shipped).toBe(22);
    expect(r.skipped["root_missing"]).toBeUndefined();
  });

  it("does not let a __proto__ index key touch prototypes", async () => {
    const { root, state } = await setup();
    await mkdir(join(state, ".."), { recursive: true });
    await writeFile(
      state,
      '{"v":1,"entries":{"__proto__":{"mtime_ms":1,"ctime_ms":1,"size":1,"session_id":null}}}',
    );
    const s = sink();
    const r = await importer(root, state, s).scan();
    expect(r.shipped).toBe(22);
    expect(({} as Record<string, unknown>)["mtime_ms"]).toBeUndefined();
  });

  it("re-ships a same-size edit whose mtime was restored (ctime changed)", async () => {
    const { root, state } = await setup();
    const s = sink();
    const imp = importer(root, state, s);
    await imp.scan();
    const f = join(root, "harness/agentic-harness/sessions/2026-09-01-0900-probe-spool.md");
    const st = await (await import("node:fs/promises")).stat(f);
    const text = await readFile(f, "utf8");
    const i = text.lastIndexOf("e");
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(f, `${text.slice(0, i)}E${text.slice(i + 1)}`);
    await utimes(f, st.atime, st.mtime);
    expect((await imp.scan()).shipped).toBe(1);
  });

  it("does not read more than the cap from a file", async () => {
    const { root, state } = await setup();
    const dir = join(root, "harness/agentic-harness/sessions");
    await writeFile(join(dir, "huge.md"), `---\nsession_id: h\n---\n${"x".repeat(5000)}`);
    const s = sink();
    const r = await importer(root, state, s, { maxFileBytes: 4000 }).scan();
    expect(r.skipped["too_large"]).toBeGreaterThanOrEqual(1);
    expect(s.lines.map((l) => l.session_id)).not.toContain("h");
  });

  it("writes no index entry until the enqueue resolved, and syncs the outbox first", async () => {
    const { root, state } = await setup();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const enq = Object.assign(
      async (l: SpoolLine): Promise<void> => {
        events.push("enqueue");
        await gate;
        void l;
      },
      {
        sync: (): void => {
          events.push(existsSync(state) ? "sync-after-index" : "sync");
        },
      },
    );
    const imp = importer(root, state, sink(), { enqueue: enq, concurrency: 22 });
    const p = imp.scan();
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(state)).toBe(false); // everything still pending
    release();
    const r = await p;
    expect(r.shipped).toBe(22);
    expect(events.filter((e) => e === "sync")).toHaveLength(1);
    expect(events).not.toContain("sync-after-index");
    expect(existsSync(state)).toBe(true);
  });

  it("stops issuing work when shouldStop turns true mid-scan and resumes later", async () => {
    const { root, state } = await setup();
    const s = sink();
    let stop = false;
    const imp = importer(root, state, s, {
      concurrency: 1,
      shouldStop: () => stop,
      enqueue: (l) => {
        s.lines.push(l);
        if (s.lines.length === 5) stop = true;
      },
    });
    const r1 = await imp.scan();
    expect(r1.shipped).toBe(5);
    stop = false;
    const r2 = await imp.scan();
    expect(r2.shipped).toBe(17);
    expect(new Set(s.lines.map((l) => l.session_id)).size).toBe(22);
  });
});

describe("invalid archive config does not stop hook forwarding (R1, R5.2)", () => {
  it("delivers a spooled hook envelope while probe.json has a bad archive block", async () => {
    const home = await tmp();
    await writeFile(
      join(home, "probe.json"),
      JSON.stringify({
        host: "h",
        hubUrl: "http://127.0.0.1:9",
        token: "tok",
        archive: { roots: [{ label: "v", path: "vault" }], intervalSec: 10 },
      }),
    );
    const got: unknown[] = [];
    const f = (async (_u: unknown, init?: RequestInit) => {
      got.push(...(JSON.parse(String(init?.body)) as { envelopes: unknown[] }).envelopes);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const d = await startDaemon({
      home,
      fetch: f,
      pollMs: 5,
      batchMs: 20,
      heartbeatMs: 0,
      rng: () => 0,
    });
    try {
      appendSpoolLines(spoolDir(home), [
        buildEnvelope({
          kind: "hook",
          host: "h",
          session_id: "s1",
          hook_event_name: "Stop",
          payload: {},
          ts: Date.now(),
        }),
      ]);
      const end = Date.now() + 5000;
      while (Date.now() < end && got.length === 0) await new Promise((r) => setTimeout(r, 10));
      expect(got.length).toBeGreaterThanOrEqual(1);
      expect(readFileSync(join(home, "daemon", "daemon.log"), "utf8")).toContain(
        "archive import off",
      );
    } finally {
      await d?.kill();
    }
  });
});

describe("defaultComponents archive wiring", () => {
  it("adds the archive component only when roots are configured", async () => {
    const home = await tmp();
    const env = { CLAUDE_CONFIG_DIR: join(home, "claude") };
    const names = (a?: Parameters<typeof defaultComponents>[2]): string[] =>
      defaultComponents(home, env, a).map((c) => c.name);
    expect(names()).not.toContain("archive");
    expect(names({ roots: [] })).not.toContain("archive");
    expect(names({ roots: [{ label: "v", path: join(home, "v") }] })).toContain("archive");
  });
});

describe("archive batching stays under the hub body limit (R5.2, U4)", () => {
  it("many max-size archive envelopes are posted in bodies under 1 MiB", async () => {
    const home = await tmp();
    const worst = '"'.repeat(200); // 2 bytes per char once JSON-escaped
    const mk = (i: number) => {
      const payload = {
        source: {
          root_label: "v",
          rel_path: `projects/p/sessions/${String(i).padStart(3, "0")}.md`,
          mtime_ms: 1,
          size: 1,
        },
        schema_version: 1,
        session_id: `s-${i}`,
        collection: "projects/p",
        title: '"'.repeat(300),
        date: "2026-01-01",
        started_at: "2026-01-01T00:00:00Z",
        ended_at: "2026-01-01T01:00:00Z",
        duration_s: 3600,
        project_dir: '"'.repeat(1024),
        branch: '"'.repeat(255),
        tools_used: Array.from({ length: 100 }, (_, k) => ({
          name: `${"t".repeat(90)}${k}`,
          count: 1,
        })),
        commits: Array.from({ length: 50 }, () => worst),
        prs: Array.from({ length: 50 }, () => worst),
        outcome: '"'.repeat(16384),
        outcome_truncated: true,
      };
      return buildEnvelope({
        kind: "archive",
        host: "h",
        session_id: `s-${i}`,
        payload,
        ts: Date.now(),
      });
    };
    const lines = Array.from({ length: 60 }, (_, i) => mk(i));
    for (const l of lines) {
      expect(ArchiveEnvelopeSchema.safeParse({ ...l, seq: 0 }).success).toBe(true);
    }
    const sizes: number[] = [];
    let got = 0;
    const f = (async (_u: unknown, init?: RequestInit) => {
      const body = String(init?.body);
      sizes.push(Buffer.byteLength(body));
      got += (JSON.parse(body) as { envelopes: unknown[] }).envelopes.length;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const d = await startDaemon({
      home,
      config: { hubUrl: "http://127.0.0.1:9", token: "tok", host: "h" },
      fetch: f,
      pollMs: 5,
      batchMs: 20,
      heartbeatMs: 0,
      rng: () => 0,
      components: [],
    });
    try {
      const put = createOutbox(outboxDir(home));
      for (const l of lines) put(l);
      const end = Date.now() + 15000;
      while (Date.now() < end && got < lines.length) await new Promise((r) => setTimeout(r, 20));
      expect(got).toBeGreaterThanOrEqual(lines.length);
      expect(sizes.length).toBeGreaterThan(1);
      expect(Math.max(...sizes)).toBeLessThan(1024 * 1024);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_BODY_BYTES);
    } finally {
      await d?.kill();
    }
  }, 30_000);
});
