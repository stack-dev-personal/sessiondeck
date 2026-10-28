import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ARCHIVE_INGEST_BODY_LIMIT,
  ARCHIVE_MAX_BRANCH,
  ARCHIVE_MAX_LIST_ENTRIES,
  ARCHIVE_MAX_LIST_ITEM,
  ARCHIVE_MAX_OUTCOME,
  ARCHIVE_MAX_PROJECT_DIR,
  ARCHIVE_MAX_TITLE,
  ARCHIVE_MAX_TOOL_NAME,
  ARCHIVE_MAX_TOOLS,
  ArchiveEnvelopeSchema,
  ArchiveSourceSchema,
  ArchiveToolSchema,
  ArchivePayloadSchema,
  isArchiveEnvelopeConsistent,
  isSafeRelPath,
  isValidIsoString,
  type ArchivePayload,
} from "../src/archive";
import { ENVELOPE_VERSION, EnvelopeSchema, parseEnvelope } from "../src/envelope";
import { FIXTURES_DIR, makeEnvelope } from "./helpers";

const VAULT = join(FIXTURES_DIR, "vault");
const HARNESS = "harness/agentic-harness/sessions";
const PROJECTS = "projects/sessiondeck/sessions";

function goldens(): { rel: string; golden: Record<string, unknown> }[] {
  const out: { rel: string; golden: Record<string, unknown> }[] = [];
  for (const dir of [HARNESS, PROJECTS]) {
    for (const f of readdirSync(join(VAULT, dir)).sort()) {
      const golden = JSON.parse(
        readFileSync(join(VAULT, "expected", dir, `${f}.json`), "utf8"),
      ) as Record<string, unknown>;
      out.push({ rel: `${dir}/${f}`, golden });
    }
  }
  return out;
}

function toPayload(golden: Record<string, unknown>): ArchivePayload {
  const source = golden["source"] as Record<string, unknown>;
  return {
    ...golden,
    source: { ...source, mtime_ms: 1_760_000_000_000, size: 1234 },
  } as ArchivePayload;
}

const base = (): ArchivePayload => toPayload(goldens()[0]!.golden);
const archiveEnv = (payload: unknown, sessionId: string | null = "s1") =>
  makeEnvelope({ kind: "archive", hook_event_name: undefined, session_id: sessionId, payload });

describe("archive envelope kind", () => {
  it("is accepted by EnvelopeSchema at v 1", () => {
    expect(ENVELOPE_VERSION).toBe(1);
    const env = parseEnvelope(archiveEnv(base(), base().session_id));
    expect(env.kind).toBe("archive");
    expect(env.v).toBe(1);
  });

  it("rejects a null session_id", () => {
    const r = EnvelopeSchema.safeParse(archiveEnv(base(), null));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("session_id");
  });
});

describe("fixture vault", () => {
  it("has exactly 20 harness files and 2 project files", () => {
    expect(readdirSync(join(VAULT, HARNESS))).toHaveLength(20);
    expect(readdirSync(join(VAULT, PROJECTS))).toHaveLength(2);
    expect(readdirSync(join(VAULT, "expected", HARNESS))).toHaveLength(20);
    expect(readdirSync(join(VAULT, "expected", PROJECTS))).toHaveLength(2);
  });

  it("shares three session_ids with the contract fixtures", () => {
    const live = new Set<string>();
    for (const dir of ["SessionStart", "Stop", "UserPromptSubmit"]) {
      for (const f of readdirSync(join(FIXTURES_DIR, dir))) {
        const p = JSON.parse(readFileSync(join(FIXTURES_DIR, dir, f), "utf8")) as {
          session_id?: string;
        };
        if (p.session_id) live.add(p.session_id);
      }
    }
    const shared = goldens().filter((g) => live.has(g.golden["session_id"] as string));
    expect(shared).toHaveLength(3);
  });

  it.each(goldens())(
    "golden $rel satisfies ArchivePayloadSchema and matches its path",
    ({ rel, golden }) => {
      const parsed = ArchivePayloadSchema.parse(toPayload(golden));
      expect(parsed.source.rel_path).toBe(rel);
      expect(parsed.collection).toBe(rel.split("/").slice(0, 2).join("/"));
      expect(parsed.outcome_truncated).toBe(false);
    },
  );

  it("source of a golden carries no mtime_ms or size", () => {
    for (const { golden } of goldens()) {
      expect(Object.keys(golden["source"] as object).sort()).toEqual(["rel_path", "root_label"]);
    }
  });

  it("includes CRLF files and a BOM file", () => {
    const files = readdirSync(join(VAULT, HARNESS)).map((f) =>
      readFileSync(join(VAULT, HARNESS, f)),
    );
    expect(files.filter((b) => b.includes("\r\n")).length).toBeGreaterThanOrEqual(2);
    expect(files.filter((b) => b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)).toHaveLength(1);
  });

  it("has the edge-case files", () => {
    const dir = join(FIXTURES_DIR, "vault-edge", HARNESS);
    expect(readdirSync(dir).sort()).toEqual([
      "no-frontmatter.md",
      "no-session-id.md",
      "notes.txt",
      "oversized-outcome.md",
      "unterminated.md",
    ]);
    expect(readFileSync(join(dir, "oversized-outcome.md"), "utf8").length).toBeGreaterThan(
      ARCHIVE_MAX_OUTCOME,
    );
  });
});

describe("ArchivePayloadSchema", () => {
  it.each([
    "../x.md",
    "a/../x.md",
    "/abs/x.md",
    "a\\b.md",
    "a//b.md",
    "./a.md",
    "C:/x.md",
    "",
    "a\0b",
  ])("rejects rel_path %j", (rel_path) => {
    const p = base();
    expect(
      ArchivePayloadSchema.safeParse({ ...p, source: { ...p.source, rel_path } }).success,
    ).toBe(false);
    expect(isSafeRelPath(rel_path)).toBe(false);
  });

  it("accepts a normal rel_path", () => {
    expect(isSafeRelPath("harness/x/sessions/a.md")).toBe(true);
  });

  it("rejects an oversize outcome, oversize arrays and oversize items", () => {
    const p = base();
    const bad = (o: Partial<ArchivePayload>) =>
      ArchivePayloadSchema.safeParse({ ...p, ...o }).success;
    expect(bad({ outcome: "x".repeat(ARCHIVE_MAX_OUTCOME) })).toBe(true);
    expect(bad({ outcome: "x".repeat(ARCHIVE_MAX_OUTCOME + 1) })).toBe(false);
    expect(bad({ commits: Array<string>(ARCHIVE_MAX_LIST_ENTRIES + 1).fill("a") })).toBe(false);
    expect(bad({ prs: Array<string>(ARCHIVE_MAX_LIST_ENTRIES).fill("a") })).toBe(true);
    expect(bad({ prs: ["x".repeat(ARCHIVE_MAX_LIST_ITEM + 1)] })).toBe(false);
    expect(
      bad({
        tools_used: Array.from({ length: ARCHIVE_MAX_TOOLS + 1 }, (_, i) => ({
          name: `t${i}`,
          count: null,
        })),
      }),
    ).toBe(false);
  });

  it("rejects malformed dates, negative numbers and an empty session_id", () => {
    const p = base();
    const bad = (o: Record<string, unknown>) =>
      ArchivePayloadSchema.safeParse({ ...p, ...o }).success;
    expect(bad({ date: "yesterday" })).toBe(false);
    expect(bad({ started_at: "2026-09-01T10:00:00Z" })).toBe(true);
    expect(bad({ duration_s: -1 })).toBe(false);
    expect(bad({ session_id: "" })).toBe(false);
    expect(bad({ source: { ...p.source, size: -1 } })).toBe(false);
    expect(bad({ source: { ...p.source, mtime_ms: 1.5 } })).toBe(false);
  });
});

describe("archive envelope consistency", () => {
  it("accepts matching session ids", () => {
    const p = base();
    const env = parseEnvelope(archiveEnv(p, p.session_id));
    expect(isArchiveEnvelopeConsistent(env)).toBe(true);
    expect(ArchiveEnvelopeSchema.safeParse(archiveEnv(p, p.session_id)).success).toBe(true);
  });

  it("rejects a payload.session_id different from the envelope session_id", () => {
    const env = parseEnvelope(archiveEnv(base(), "other-session"));
    expect(isArchiveEnvelopeConsistent(env)).toBe(false);
    const r = ArchiveEnvelopeSchema.safeParse(archiveEnv(base(), "other-session"));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("payload");
  });

  it("rejects other kinds, a null session_id and an invalid payload", () => {
    const hook = parseEnvelope(makeEnvelope());
    expect(isArchiveEnvelopeConsistent(hook)).toBe(false);
    expect(ArchiveEnvelopeSchema.safeParse(makeEnvelope()).success).toBe(false);
    const probeEnv = parseEnvelope(
      makeEnvelope({
        kind: "archive",
        hook_event_name: undefined,
        session_id: "s",
        payload: { nope: 1 },
      }),
    );
    expect(isArchiveEnvelopeConsistent(probeEnv)).toBe(false);
    expect(ArchiveEnvelopeSchema.safeParse(archiveEnv({ nope: 1 }, "s")).success).toBe(false);
    expect(isArchiveEnvelopeConsistent({ ...probeEnv, session_id: null })).toBe(false);
  });
});

describe("archive schema hardening", () => {
  const ok = (o: Record<string, unknown>) =>
    ArchivePayloadSchema.safeParse({ ...base(), ...o }).success;

  it("a worst-case max-size payload stays well under the ingest body limit", () => {
    const ctl = "\u0001"; // 6 bytes in JSON. C0 is rejected by the schema, so the schema-valid worst
    const worst = "\u2028"; // is a 3-byte UTF-8 char that JSON.stringify leaves raw; bound both
    for (const ch of [worst, ctl]) {
      const p = {
        ...base(),
        title: ch.repeat(ARCHIVE_MAX_TITLE),
        project_dir: ch.repeat(ARCHIVE_MAX_PROJECT_DIR),
        branch: ch.repeat(ARCHIVE_MAX_BRANCH),
        tools_used: Array.from({ length: ARCHIVE_MAX_TOOLS }, () => ({
          name: ch.repeat(ARCHIVE_MAX_TOOL_NAME),
          count: 1,
        })),
        commits: Array<string>(ARCHIVE_MAX_LIST_ENTRIES).fill(ch.repeat(ARCHIVE_MAX_LIST_ITEM)),
        prs: Array<string>(ARCHIVE_MAX_LIST_ENTRIES).fill(ch.repeat(ARCHIVE_MAX_LIST_ITEM)),
        outcome: ch.repeat(ARCHIVE_MAX_OUTCOME),
      };
      const bytes = Buffer.byteLength(JSON.stringify(archiveEnv(p, p.session_id)), "utf8");
      expect(bytes).toBeLessThan(ARCHIVE_INGEST_BODY_LIMIT / 2);
    }
    // 6 bytes per unit is the JSON worst case, so even all escaped it fits
    const units =
      ARCHIVE_MAX_TITLE +
      ARCHIVE_MAX_PROJECT_DIR +
      ARCHIVE_MAX_BRANCH +
      ARCHIVE_MAX_TOOLS * ARCHIVE_MAX_TOOL_NAME +
      2 * ARCHIVE_MAX_LIST_ENTRIES * ARCHIVE_MAX_LIST_ITEM +
      ARCHIVE_MAX_OUTCOME;
    expect(units * 6).toBeLessThan(ARCHIVE_INGEST_BODY_LIMIT / 2);
  });

  it("rejects unknown keys in payload, source and tools, and strips none", () => {
    const p = base();
    expect(ok({ junk: "x".repeat(1000) })).toBe(false);
    expect(ok({ source: { ...p.source, junk: 1 } })).toBe(false);
    expect(ok({ tools_used: [{ name: "a", count: 1, junk: 1 }] })).toBe(false);
    expect(
      ArchiveEnvelopeSchema.safeParse(archiveEnv({ ...p, junk: { a: [1] } }, p.session_id)).success,
    ).toBe(false);
  });

  it("ArchiveEnvelopeSchema returns the parsed payload", () => {
    const p = base();
    const r = ArchiveEnvelopeSchema.parse(archiveEnv(p, p.session_id));
    expect(r.payload).toEqual(p);
  });

  it("bounds duration_s, tool count, mtime_ms and size", () => {
    const p = base();
    expect(ok({ duration_s: 1e300 })).toBe(false);
    expect(ok({ duration_s: 30 * 86400 })).toBe(true);
    expect(ok({ duration_s: 30 * 86400 + 1 })).toBe(false);
    expect(ok({ tools_used: [{ name: "a", count: 1_000_001 }] })).toBe(false);
    expect(ok({ source: { ...p.source, mtime_ms: 2 ** 60 } })).toBe(false);
    expect(ok({ source: { ...p.source, size: 2 ** 60 } })).toBe(false);
  });

  it("rejects out-of-range ISO components", () => {
    for (const v of [
      "2026-99-99",
      "2026-02-30",
      "2026-09-01T25:00",
      "2026-09-01T10:61",
      "2026-09-01T10:00:61",
      "2026-00-10",
    ]) {
      expect(isValidIsoString(v), v).toBe(false);
      expect(ok({ date: v }), v).toBe(false);
    }
    for (const v of [
      "2026-02-28",
      "2024-02-29",
      "2026-09-01T23:59:59.5+02:00",
      "2026-09-01 10:00Z",
    ]) {
      expect(isValidIsoString(v), v).toBe(true);
    }
  });

  it("restricts session_id, root_label and collection", () => {
    const p = base();
    for (const id of ["a b", "a\nb", " x", "a/b", "x".repeat(129)])
      expect(ok({ session_id: id }), id).toBe(false);
    for (const rl of ["../x", "a/b", "a\\b", "a\0b", "-x", ""]) {
      expect(ok({ source: { ...p.source, root_label: rl } }), rl).toBe(false);
    }
    expect(ok({ collection: "harness/other" })).toBe(false);
    expect(ok({ collection: null })).toBe(true);
  });

  it("rejects unsafe rel_path forms", () => {
    for (const r of [
      "harness/x/sessions/a:b.md",
      "harness/x/sessions/a\x01.md",
      "harness/x/sessions/a .md/b.md",
      "harness/x./sessions/a.md",
      "harness/CON/sessions/a.md",
      "harness/x/sessions/nul.md",
      "harness/x/sessions/COM1.txt.md",
      "other/x/sessions/a.md",
      "harness/x/y/a.md",
      "harness/x/sessions/a.txt",
      "harness/x/sessions/a/b.md",
    ]) {
      expect(isSafeRelPath(r), r).toBe(false);
    }
    expect(isSafeRelPath("projects/sessiondeck/sessions/2026-09-11.md")).toBe(true);
  });

  it("rejects C0 controls in text fields but allows newline and tab", () => {
    expect(ok({ title: "a\u0007b" })).toBe(false);
    expect(ok({ branch: "a\u0000b" })).toBe(false);
    expect(ok({ project_dir: "a\u001bb" })).toBe(false);
    expect(ok({ commits: ["a\u0001"] })).toBe(false);
    expect(ok({ prs: ["a\u0001"] })).toBe(false);
    expect(ok({ tools_used: [{ name: "a\u0001", count: null }] })).toBe(false);
    expect(ok({ outcome: "a\u0001" })).toBe(false);
    expect(ok({ title: "a\tb\nc", outcome: "a\r\n\tb" })).toBe(true);
  });
});

describe("leak-check key mirror", () => {
  it("scripts/lib/fixture-leak-core.mjs lists exactly the schema keys", async () => {
    const url = new URL("../../../scripts/lib/fixture-leak-core.mjs", import.meta.url).href;
    const core = (await import(/* @vite-ignore */ url)) as Record<string, string[]>;
    expect([...core["ARCHIVE_PAYLOAD_KEYS"]!].sort()).toEqual(
      Object.keys(ArchivePayloadSchema.innerType().shape).sort(),
    );
    expect([...core["ARCHIVE_SOURCE_KEYS"]!].sort()).toEqual(
      Object.keys(ArchiveSourceSchema.shape).sort(),
    );
    expect([...core["ARCHIVE_TOOL_KEYS"]!].sort()).toEqual(
      Object.keys(ArchiveToolSchema.shape).sort(),
    );
  });
});
