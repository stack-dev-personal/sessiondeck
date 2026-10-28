import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ARCHIVE_MAX_LIST_ENTRIES,
  ARCHIVE_MAX_LIST_ITEM,
  ARCHIVE_MAX_OUTCOME,
  ARCHIVE_MAX_TOOLS,
  ArchiveEnvelopeSchema,
  ArchivePayloadSchema,
  isArchiveEnvelopeConsistent,
  isSafeRelPath,
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
