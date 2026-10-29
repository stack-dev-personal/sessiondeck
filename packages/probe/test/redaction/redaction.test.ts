import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SECRET_VALUE_PREFIXES } from "../../../contract/src/state-file-secrets.ts";
import { compileRedactionConfig } from "../../src/redaction/config.ts";
import { createRedactor, redactorFromConfig } from "../../src/redaction/redactor.ts";
import { BUILTIN_RULE_NAMES } from "../../src/redaction/rules.ts";
import { readConfig, writeConfig } from "../../src/config/config.ts";
import { TranscriptTailer } from "../../src/daemon/transcript.ts";
import type { SpoolLine } from "../../src/spool-format.ts";
import { fixturesDir } from "../helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const gen = join(here, ".generated");
const lines = (f: string): string[] =>
  readFileSync(join(gen, f), "utf8").split("\n").filter(Boolean);
const secretLines = lines("secret-corpus.txt");
const expected = JSON.parse(readFileSync(join(gen, "secret-corpus.expected.json"), "utf8")) as {
  secrets: string[];
  json: boolean;
}[];
const benignLines = lines("benign-corpus.txt");
const red = createRedactor();

/** A secret leaks if it appears literally or in its JSON-escaped form. */
const leaks = (out: string, s: string): boolean =>
  out.includes(s) || out.includes(JSON.stringify(s).slice(1, -1));

describe("corpora", () => {
  it("has 200 + 200 lines and a matching sidecar", () => {
    expect(secretLines).toHaveLength(200);
    expect(expected).toHaveLength(200);
    expect(benignLines).toHaveLength(200);
    for (const e of expected) expect(e.secrets.length).toBeGreaterThan(0);
  });

  it("secret corpus: 0 leaks, JSON stays valid", () => {
    let leaked = 0;
    const bad: string[] = [];
    secretLines.forEach((line, i) => {
      const out = red.redactLine(line);
      const e = expected[i]!;
      for (const s of e.secrets) {
        if (leaks(out, s)) {
          leaked += 1;
          bad.push(`line ${i + 1}: ${s.slice(0, 12)}...`);
          break;
        }
      }
      if (e.json) expect(() => JSON.parse(out), `line ${i + 1}`).not.toThrow();
      expect(out).toContain("[redacted:");
    });
    console.log(`redaction corpus: leaks: ${leaked}/${secretLines.length}`);
    expect(bad).toEqual([]);
  });

  it("benign corpus: under 2% of lines change", () => {
    const changed = benignLines.filter((l) => red.redactLine(l) !== l);
    const pct = (changed.length / benignLines.length) * 100;
    console.log(
      `redaction corpus: false positives: ${changed.length}/${benignLines.length} = ${pct.toFixed(1)}%`,
    );
    if (changed.length > 0) console.log(changed.map((l) => `  FP: ${l}`).join("\n"));
    expect(pct).toBeLessThan(2);
  });

  it("every contract secret prefix is redacted when followed by a body", () => {
    for (const p of SECRET_VALUE_PREFIXES) {
      const s = `${p}FAKE0123456789abcdefghij`;
      expect(red.redactLine(`value ${s} end`), p).not.toContain(s);
    }
  });
});

describe("rules", () => {
  it("keeps the key and replaces the value with a rule marker", () => {
    expect(red.redactLine("API_KEY=abcdef123456")).toBe("API_KEY=[redacted:env-assignment]");
    expect(red.redactLine('{"a":"x"}')).toBe('{"a":"x"}');
    expect(red.redactLine('curl -H "Authorization: Bearer abcDEF123456xyz"')).toBe(
      'curl -H "Authorization: Bearer [redacted:auth-header]"',
    );
    expect(red.redactLine("postgres://app:" + "s3cr3tpw@db/x")).toBe(
      "postgres://app:[redacted:url-credentials]@db/x",
    );
  });

  it("redacts inside escaped JSON strings and keys, and keeps untouched lines byte-identical", () => {
    const row = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: 'TOKEN="ab\\cd1234"\nOK=1\n' }] },
    });
    const out = red.redactLine(row);
    expect(JSON.parse(out).message.content[0].content).toBe(
      'TOKEN="[redacted:env-assignment]"\nOK=1\n',
    );
    const plain = '{"a":"caf\\u00e9","n":1.0}';
    expect(red.redactLine(plain)).toBe(plain);
  });

  it("redacts structured secret keys but not look-alikes", () => {
    const out = JSON.parse(
      red.redactLine(
        '{"password":"hunter2hunter2","max_tokens":"1000","task_key":"abc-1234","token":"<your-token>"}',
      ),
    );
    expect(out.password).toBe("[redacted:secret-key]");
    expect(out.max_tokens).toBe("1000");
    expect(out.task_key).toBe("abc-1234");
    expect(out.token).toBe("<your-token>");
  });

  it("redacts an unparseable line as raw text and still ships it", () => {
    const out = red.redactLine(
      '{"cmd": "export GH_TOKEN=ghp_FAKEabcdefg' + 'hijklmnopqrstuv", broken',
    );
    expect(out).not.toContain("ghp_FAKE");
    expect(out).toContain("[redacted:");
    expect(
      red.redactLine('oops \\"api_key\\": \\"sk-FAKEabcdef' + 'ghijklmnopqrstuvwx1\\" {'),
    ).not.toContain("sk-FAKE");
  });

  it("handles deep nesting without throwing", () => {
    const deep = `${"[".repeat(200)}"TOKEN=abcdefg12345"${"]".repeat(200)}`;
    expect(red.redactLine(deep)).not.toContain("abcdefg12345");
  });

  it("is linear on adversarial input", () => {
    const inputs = [
      "A_".repeat(20000),
      "-----BEGIN PR" + "IVATE KEY-----" + "A".repeat(200000),
      "sk-" + "a".repeat(200000),
      "x://" + "a:".repeat(50000),
      "password" + " ".repeat(100000) + "=",
      "a".repeat(100000) + "_KEY",
      "curl " + "-u ".repeat(30000),
      "Bearer " + "a".repeat(200000),
      "=".repeat(200000),
    ];
    for (const s of inputs) {
      const t = performance.now();
      red.redactLine(s);
      red.redactLine(JSON.stringify(s));
      expect(performance.now() - t, s.slice(0, 20)).toBeLessThan(1500);
    }
  });
});

describe("config", () => {
  it("defaults on; only explicit false disables", () => {
    expect(red.enabled).toBe(true);
    for (const v of [undefined, {}, { enabled: true }]) {
      expect(redactorFromConfig(v).redactor.enabled).toBe(true);
    }
    const off = redactorFromConfig({ enabled: false });
    expect(off.redactor.enabled).toBe(false);
    expect(off.redactor.redactLine("API_KEY=abcdef123456")).toBe("API_KEY=abcdef123456");
    expect(redactorFromConfig({ enabled: "no" }).redactor.enabled).toBe(true);
  });

  it("deny adds rules, allow exempts spans, disableRules drops built-ins", () => {
    const r = redactorFromConfig({
      deny: [{ name: "corp-id", pattern: "CORP-[0-9]{6}", flags: "i" }],
      allow: ["^ghp_EXAMPLE"],
      disableRules: ["aws-key"],
    });
    expect(r.error).toBeUndefined();
    const x = r.redactor;
    expect(x.redactLine("see corp-123456 now")).toBe("see [redacted:corp-id] now");
    expect(x.redactLine("t ghp_EXAMPLE012" + "3456789abcdefgh ok")).toContain("ghp_EXAMPLE");
    expect(x.redactLine("t ghp_REAL012345" + "6789abcdefghij ok")).not.toContain("ghp_REAL");
    expect(x.redactLine("k AKIAFAKEAB" + "CDEFGH1234 k")).toContain("AKIAFAKE");
  });

  it.each([
    [{ deny: [{ name: "a", pattern: "(" }] }, /invalid regular expression/],
    [{ deny: [{ name: "a", pattern: "(a+)+$" }] }, /nested quantifier/],
    [{ deny: [{ name: "a", pattern: "x*" }] }, /empty string/],
    [{ deny: [{ name: "a", pattern: "x", flags: "y" }] }, /flags/],
    [{ deny: [{ name: "env-assignment", pattern: "x" }] }, /already used/],
    [{ allow: ["["] }, /allow\[0\]/],
    [{ disableRules: ["nope"] }, /not a built-in/],
    [{ enabled: false, deny: [{ name: "a", pattern: "(" }] }, /invalid/],
    [{ bogus: 1 }, /unknown key/],
    ["x", /must be an object/],
  ])("rejects %j and falls back to built-ins, enabled", (raw, msg) => {
    const c = compileRedactionConfig(raw);
    expect(c.ok).toBe(false);
    const r = redactorFromConfig(raw);
    expect(r.error).toMatch(msg);
    expect(r.redactor.enabled).toBe(true);
    expect(r.redactor.redactLine("API_KEY=abcdef123456")).toContain("[redacted:");
  });

  it("windows long input for user patterns", () => {
    const r = redactorFromConfig({ deny: [{ name: "z", pattern: "ZZZ[0-9]+" }] }).redactor;
    expect(r.redactLine(`${"a ".repeat(5000)}ZZZ123`)).toContain("[redacted:z]");
  });

  it("probe.json round-trips the section and reports an error", async () => {
    const d = mkdtempSync(join(tmpdir(), "sd-redcfg-"));
    try {
      const p = join(d, "probe.json");
      const section = { deny: [{ name: "q", pattern: "Q[0-9]+" }], allow: ["EXAMPLE"] };
      await writeConfig(p, { host: "h", redaction: section });
      const cfg = await readConfig(p);
      expect(cfg?.redaction).toEqual(section);
      expect(cfg?.redactionError).toBeUndefined();
      writeFileSync(
        p,
        JSON.stringify({ host: "h", redaction: { deny: [{ name: "q", pattern: "(" }] } }),
      );
      expect((await readConfig(p))?.redactionError).toMatch(/invalid regular expression/);
      expect(BUILTIN_RULE_NAMES).toContain("private-key");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("probe.json with a BOM", () => {
  it("is read (PowerShell 5 Set-Content -Encoding UTF8 writes one)", async () => {
    const d = mkdtempSync(join(tmpdir(), "sd-redbom-"));
    try {
      const p = join(d, "probe.json");
      writeFileSync(p, `\uFEFF${JSON.stringify({ host: "h", redaction: { allow: ["EXAMPLE"] } })}`);
      const cfg = await readConfig(p);
      expect(cfg?.host).toBe("h");
      expect(cfg?.redaction).toEqual({ allow: ["EXAMPLE"] });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("tailer wiring", () => {
  let dir: string;
  let out: SpoolLine[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sd-redtail-"));
    out = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const shipped = (): string[] => out.flatMap((l) => (l.payload as { lines: string[] }).lines);
  const mk = (
    extra: Partial<ConstructorParameters<typeof TranscriptTailer>[0]> = {},
  ): TranscriptTailer =>
    new TranscriptTailer({
      statePath: join(dir, "offsets.json"),
      enqueue: (l) => out.push(l),
      host: "h",
      pollMs: 0,
      projectsDir: dir,
      ...extra,
    });

  it("ships every secret-corpus line, wrapped as a tool_result row, redacted", async () => {
    const rows = secretLines.map((l) =>
      JSON.stringify({
        type: "user",
        uuid: "u1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: l }],
        },
      }),
    );
    const f = join(dir, "t.jsonl");
    writeFileSync(f, rows.map((r) => `${r}\n`).join(""));
    const t = mk();
    await t.onSessionStart("s1", f);
    await t.poll();
    const got = shipped();
    expect(got).toHaveLength(200);
    let leaked = 0;
    got.forEach((row, i) => {
      const parsed = JSON.parse(row) as { message: { content: { content: string }[] } };
      const text = parsed.message.content[0]!.content;
      for (const s of expected[i]!.secrets) if (leaks(row, s) || text.includes(s)) leaked += 1;
    });
    console.log(`tailer end to end: leaks: ${leaked}/${got.length}`);
    expect(leaked).toBe(0);
  });

  it("redacts subagent transcripts and tags the envelope with the agent id", async () => {
    const main = join(dir, "proj", "s1.jsonl");
    mkdirSync(join(dir, "proj", "s1", "subagents"), { recursive: true });
    writeFileSync(main, '{"c":"x"}\n');
    writeFileSync(
      join(dir, "proj", "s1", "subagents", "agent-ab12.jsonl"),
      '{"c":"export GH_TOKEN=ghp_FAKEabcdefg' + 'hijklmnopqrstuv"}\n{"c":"ok"}\n',
    );
    const t = mk({ projectsDir: join(dir, "proj") });
    await t.onSessionStart("s1", main);
    await t.onSubagentStart("s1", "ab12", main);
    await t.poll();
    const sub = out.filter((l) => l.agent_id === "ab12");
    expect(sub).toHaveLength(1);
    const rows = (sub[0]!.payload as { lines: string[] }).lines;
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toContain("ghp_FAKE");
    expect(rows[0]).toContain("[redacted:");
    expect(rows[1]).toBe('{"c":"ok"}');
  });

  it("a raw line over the limit becomes a marker without being scanned; growth is caught too", async () => {
    const f = join(dir, "main.jsonl");
    const big = `{"c":"${"sk-".repeat(100000)}"}`;
    const grows = `{"c":"${"TOKEN=abcd ".repeat(50)}"}`; // ~560 bytes raw, larger once redacted
    writeFileSync(f, `${big}\n${grows}\n{"c":"x"}\n`);
    const seen: number[] = [];
    const inner = createRedactor();
    const spy = {
      enabled: true,
      redactLine: (l: string): string => {
        seen.push(l.length);
        return inner.redactLine(l);
      },
    };
    const t = mk({ maxLineJsonBytes: 600, redactor: spy });
    await t.onSessionStart("s1", f);
    await t.poll();
    // the big line never reached the redactor; the two small ones did
    expect(seen).toHaveLength(2);
    expect(Math.max(...seen)).toBeLessThan(700);
    const got = shipped();
    expect(got).toHaveLength(3);
    expect(got[0]).toContain("sessiondeck_marker");
    expect(got[1]).toContain("sessiondeck_marker");
    expect(got[2]).toBe('{"c":"x"}');
    expect(t.stats.markers).toBe(2);
  });

  it("redaction disabled in the tailer ships the line as is", async () => {
    const f = join(dir, "x.jsonl");
    writeFileSync(f, '{"c":"API_KEY=abcdef123456"}\n');
    const t = mk({ redactor: redactorFromConfig({ enabled: false }).redactor });
    await t.onSessionStart("s1", f);
    await t.poll();
    expect(shipped()).toEqual(['{"c":"API_KEY=abcdef123456"}']);
  });

  it("reads probe.json at start (disabled, and a bad rule falls back)", async () => {
    const home = join(dir, "home");
    mkdirSync(home);
    const f = join(dir, "x.jsonl");
    writeFileSync(f, '{"c":"API_KEY=abcdef123456"}\n');
    const logs: string[] = [];
    const ctx = (): {
      home: string;
      host: string;
      log: (l: string, m: string) => void;
      enqueue: (l: SpoolLine) => void;
    } => ({
      home,
      host: "h",
      log: (l, m) => logs.push(`${l} ${m}`),
      enqueue: (l) => out.push(l),
    });
    const { probeConfigFile } = await import("../../src/paths.ts");
    writeFileSync(
      probeConfigFile(home),
      JSON.stringify({ host: "h", redaction: { deny: [{ name: "a", pattern: "(" }] } }),
    );
    const t = mk({ statePath: join(dir, "o3.json") });
    await t.start(ctx());
    await t.onSessionStart("s3", f);
    await t.poll();
    await t.stop();
    expect(shipped()[0]).toContain("[redacted:");
    expect(logs.join("\n")).toMatch(/invalid regular expression/);
  });

  it("start logs allow-pattern counts and lengths, never their sources", async () => {
    const home = join(dir, "home2");
    mkdirSync(home);
    const logs: string[] = [];
    const { probeConfigFile } = await import("../../src/paths.ts");
    writeFileSync(
      probeConfigFile(home),
      JSON.stringify({ host: "h", redaction: { allow: ["^ghp_REALTOKEN1234"] } }),
    );
    const t = mk({ statePath: join(dir, "o4.json") });
    await t.start({
      home,
      host: "h",
      log: (l, m) => logs.push(`${l} ${m}`),
      enqueue: (l) => out.push(l),
    });
    await t.stop();
    const all = logs.join("\n");
    expect(all).toMatch(/1 pattern/);
    expect(all).not.toContain("REALTOKEN");
  });
});

describe("bench", () => {
  it("fixture transcripts: lines per second and p95 per line", () => {
    const root = join(fixturesDir, "transcripts");
    const rows: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".jsonl"))
          rows.push(...readFileSync(p, "utf8").split("\n").filter(Boolean));
      }
    };
    walk(root);
    expect(rows.length).toBeGreaterThan(50);
    for (const r of rows.slice(0, 200)) red.redactLine(r); // warm up
    const times: number[] = [];
    let changed = 0;
    const t0 = performance.now();
    for (const r of rows) {
      const a = performance.now();
      if (red.redactLine(r) !== r) changed += 1;
      times.push(performance.now() - a);
    }
    const total = performance.now() - t0;
    times.sort((a, b) => a - b);
    const p = (q: number): number =>
      times[Math.min(times.length - 1, Math.floor(times.length * q))]!;
    const bytes = rows.reduce((n, r) => n + r.length, 0);
    console.log(
      `redaction bench: ${rows.length} lines, ${(bytes / 1e6).toFixed(2)} MB, ${Math.round((rows.length / total) * 1000)} lines/s, ` +
        `${(bytes / 1e6 / (total / 1000)).toFixed(1)} MB/s, p50 ${p(0.5).toFixed(3)} ms, p95 ${p(0.95).toFixed(3)} ms, p99 ${p(0.99).toFixed(3)} ms, max ${p(1).toFixed(3)} ms, changed ${changed}`,
    );
    expect(p(0.95)).toBeLessThan(5);
  });
});
