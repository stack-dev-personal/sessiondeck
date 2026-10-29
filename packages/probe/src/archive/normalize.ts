// Frontmatter + body + path -> ArchivePayload (R5.2). The field rules follow
// packages/contract/fixtures/vault/README.md and the goldens next to it. Lenient on optional
// fields (an unparseable date or duration becomes null), strict on identity (no valid session_id
// means the file is skipped). Text fields are redacted before validation.
import {
  ARCHIVE_MAX_BRANCH,
  ARCHIVE_MAX_COLLECTION,
  ARCHIVE_MAX_DURATION_S,
  ARCHIVE_MAX_LIST_ENTRIES,
  ARCHIVE_MAX_LIST_ITEM,
  ARCHIVE_MAX_OUTCOME,
  ARCHIVE_MAX_PROJECT_DIR,
  ARCHIVE_MAX_TIMESTAMP,
  ARCHIVE_MAX_TITLE,
  ARCHIVE_MAX_TOOLS,
  ARCHIVE_MAX_TOOL_COUNT,
  ARCHIVE_MAX_TOOL_NAME,
  type ArchivePayload,
  ArchivePayloadSchema,
  isSafeRelPath,
  isValidIsoString,
} from "@sessiondeck/contract";
import { type YamlMap, type YamlValue, parseFrontmatter } from "./frontmatter.ts";
import { MAX_REDACT_INPUT, redactText } from "./redact.ts";

export type SkipReason =
  | "no_frontmatter"
  | "unterminated_frontmatter"
  | "unsupported_yaml"
  | "malformed_yaml"
  | "frontmatter_not_map"
  | "no_session_id"
  | "bad_rel_path"
  | "invalid_payload";

export type NormalizeResult =
  { ok: true; payload: ArchivePayload } | { ok: false; reason: SkipReason };

export interface NormalizeInput {
  text: string;
  rootLabel: string;
  /** Vault-relative path with forward slashes. */
  relPath: string;
  mtimeMs: number;
  size: number;
}

// C0 controls except \n and \t (and \r for the outcome).
// eslint-disable-next-line no-control-regex
const CTL = /[\x00-\x08\x0b-\x1f\x7f]/g;
// eslint-disable-next-line no-control-regex
const CTL_KEEP_CR = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Cuts to max UTF-16 units without leaving half a surrogate pair. */
export function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

function scalarText(v: YamlValue | undefined): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function text(v: YamlValue | undefined, max: number, redact = false): string | null {
  const raw = scalarText(v);
  if (raw === null) return null;
  let s = raw.replace(CTL, " ").trim();
  if (redact) s = redactText(s);
  s = cut(s, max).trim();
  return s === "" ? null : s;
}

function iso(v: YamlValue | undefined): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length <= ARCHIVE_MAX_TIMESTAMP && isValidIsoString(s) ? s : null;
}

const DURATION =
  /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?$/i;

function seconds(v: YamlValue | undefined): number | null {
  let n: number | null = null;
  if (typeof v === "number") n = v;
  else if (typeof v === "string") {
    const s = v.trim();
    if (/^\d+(?:\.\d+)?$/.test(s)) n = Number(s);
    else {
      const m = DURATION.exec(s);
      if (m && (m[1] || m[2] || m[3])) {
        n = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
      }
    }
  }
  if (n === null || !Number.isFinite(n) || n < 0 || n > ARCHIVE_MAX_DURATION_S) return null;
  return n;
}

function count(v: YamlValue | undefined): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= ARCHIVE_MAX_TOOL_COUNT
    ? v
    : null;
}

type Tool = ArchivePayload["tools_used"][number];

function tools(v: YamlValue | undefined): Tool[] {
  const out: Tool[] = [];
  const add = (name: string, c: number | null): void => {
    if (out.length >= ARCHIVE_MAX_TOOLS) return;
    const n = cut(name.replace(CTL, " ").trim(), ARCHIVE_MAX_TOOL_NAME).trim();
    if (n !== "") out.push({ name: n, count: c });
  };
  const fromMap = (m: YamlMap): void => {
    for (const k of Object.keys(m)) add(k, count(m[k]));
  };
  if (Array.isArray(v)) {
    for (const it of v) {
      if (typeof it === "string") add(it, null);
      else if (typeof it === "number" || typeof it === "boolean") add(String(it), null);
      else if (it !== null && typeof it === "object" && !Array.isArray(it)) fromMap(it);
    }
  } else if (v !== null && typeof v === "object") fromMap(v as YamlMap);
  return out;
}

function list(v: YamlValue | undefined): string[] {
  const items = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  const out: string[] = [];
  for (const it of items) {
    if (out.length >= ARCHIVE_MAX_LIST_ENTRIES) break;
    let raw: string | null = scalarText(it);
    if (raw === null && it !== null && typeof it === "object" && !Array.isArray(it)) {
      // `- fix: thing` reads as a one-key map; keep the author's text.
      raw = Object.keys(it)
        .map((k) => `${k}: ${scalarText((it as YamlMap)[k]) ?? ""}`.trim())
        .join(", ");
    }
    if (raw === null) continue;
    const s = text(raw, ARCHIVE_MAX_LIST_ITEM, true);
    if (s !== null) out.push(s);
  }
  return out;
}

/** Parses and normalizes one capture file. Never throws. */
export function normalizeCapture(input: NormalizeInput): NormalizeResult {
  if (!isSafeRelPath(input.relPath)) return { ok: false, reason: "bad_rel_path" };
  const fm = parseFrontmatter(input.text);
  if (fm.kind === "skip") return { ok: false, reason: fm.reason };
  const d = fm.data;

  const sid = typeof d["session_id"] === "string" ? d["session_id"].trim() : "";
  if (!/^[A-Za-z0-9-]{1,128}$/.test(sid)) return { ok: false, reason: "no_session_id" };

  const sv = d["schema_version"];
  const body = fm.body.replace(CTL_KEEP_CR, " ").trim();
  const redacted = redactText(
    body.length > MAX_REDACT_INPUT ? body.slice(0, MAX_REDACT_INPUT) : body,
  ).trim();
  const outcome = cut(redacted, ARCHIVE_MAX_OUTCOME);
  const truncated = body.length > MAX_REDACT_INPUT || redacted.length > ARCHIVE_MAX_OUTCOME;

  const candidate: ArchivePayload = {
    source: {
      root_label: input.rootLabel,
      rel_path: input.relPath,
      mtime_ms: input.mtimeMs,
      size: input.size,
    },
    schema_version: typeof sv === "number" && Number.isInteger(sv) && sv >= 0 ? sv : null,
    session_id: sid,
    collection: cut(input.relPath.split("/").slice(0, 2).join("/"), ARCHIVE_MAX_COLLECTION),
    title: text(d["title"], ARCHIVE_MAX_TITLE, true),
    date: iso(d["date"]),
    started_at: iso(d["started_at"]),
    ended_at: iso(d["ended_at"]),
    duration_s: seconds(d["duration_s"] !== undefined ? d["duration_s"] : d["duration"]),
    project_dir: text(
      d["project_dir"] !== undefined && d["project_dir"] !== null ? d["project_dir"] : d["cwd"],
      ARCHIVE_MAX_PROJECT_DIR,
      true,
    ),
    branch: text(d["branch"], ARCHIVE_MAX_BRANCH, true),
    tools_used: tools(d["tools_used"]),
    commits: list(d["commits"]),
    prs: list(d["prs"]),
    outcome,
    outcome_truncated: truncated,
  };
  const parsed = ArchivePayloadSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, reason: "invalid_payload" };
  return { ok: true, payload: parsed.data };
}
