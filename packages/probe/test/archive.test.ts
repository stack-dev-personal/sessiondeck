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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArchiveEnvelopeSchema, ArchivePayloadSchema } from "@sessiondeck/contract";
import { parseFrontmatter } from "../src/archive/frontmatter.ts";
import { ArchiveImporter } from "../src/archive/importer.ts";
import { normalizeCapture } from "../src/archive/normalize.ts";
import { redactText } from "../src/archive/redact.ts";
import { ArchiveComponent } from "../src/daemon/archive.ts";
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
    expect(redactText("Authorization: Bearer abc123def456ghi")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
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

describe("importer", () => {
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
    await expect(readConfig(p)).rejects.toThrow(/absolute/);
  });
});
