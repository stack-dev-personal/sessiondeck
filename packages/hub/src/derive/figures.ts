// R2.12. Pure reading of the session figures a Claude Code transcript row states. Nothing here
// touches the database or a snapshot: `readRow` turns one raw JSONL line into the facts it carries,
// `foldForward` applies lines in order (live ingest), `foldBackward` finds the newest value of each
// figure scanning from the end (rebuild after a restart, replay, out-of-order arrival).

/** The figures derived from a session's main transcript (agent_id ''), plus the newest line seen. */
export interface TranscriptFigures {
  model: string | null;
  /** input + cache_creation + cache_read tokens of the last assistant row that has usage. */
  contextTokens: number | null;
  branch: string | null;
  /** Last assistant text block, uncapped; applyFigures caps it. */
  message: string | null;
  /** Highest line_no seen (any row kind), -1 when none. */
  maxLine: number;
}

export const EMPTY_FIGURES: TranscriptFigures = {
  model: null,
  contextTokens: null,
  branch: null,
  message: null,
  maxLine: -1,
};

interface RowFacts {
  branch: string | null;
  model: string | null;
  contextTokens: number | null;
  message: string | null;
}

/** Claude Code writes this model on locally generated rows (errors, interrupts); not a real turn. */
const SYNTHETIC_MODEL = "<synthetic>";
const ASSISTANT_MARK = '"type":"assistant"';
const BRANCH_RE = /"gitBranch":("(?:[^"\\]|\\.)*")/;

const NO_FACTS: RowFacts = { branch: null, model: null, contextTokens: null, message: null };

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function branchOf(raw: string): string | null {
  const m = raw.match(BRANCH_RE);
  if (m?.[1] === undefined) return null;
  try {
    const b: unknown = JSON.parse(m[1]);
    return typeof b === "string" && b !== "" ? b : null;
  } catch {
    return null;
  }
}

function lastTextBlock(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (let i = content.length - 1; i >= 0; i--) {
    const b: unknown = content[i];
    if (isRecord(b) && b["type"] === "text" && typeof b["text"] === "string" && b["text"] !== "") {
      return b["text"];
    }
  }
  return null;
}

function usageTokens(usage: unknown): number | null {
  if (!isRecord(usage)) return null;
  const keys = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
  if (!keys.some((k) => typeof usage[k] === "number")) return null;
  return keys.reduce((sum, k) => sum + num(usage[k]), 0);
}

/**
 * The facts one raw line carries. Only lines that look like assistant rows are JSON-parsed; a line
 * that looks like one but does not parse is reported through onMalformed and contributes nothing
 * but a branch. Never throws.
 */
export function readRow(raw: string, onMalformed: () => void): RowFacts {
  const branch = branchOf(raw);
  if (!raw.includes(ASSISTANT_MARK)) return branch === null ? NO_FACTS : { ...NO_FACTS, branch };
  let row: unknown;
  try {
    row = JSON.parse(raw);
  } catch {
    onMalformed();
    return { ...NO_FACTS, branch };
  }
  if (!isRecord(row) || row["type"] !== "assistant" || row["isSidechain"] === true) {
    return { ...NO_FACTS, branch };
  }
  const message = row["message"];
  if (!isRecord(message)) return { ...NO_FACTS, branch };
  const model = typeof message["model"] === "string" ? message["model"] : "";
  if (model === SYNTHETIC_MODEL) return { ...NO_FACTS, branch };
  return {
    branch,
    model: model === "" ? null : model,
    contextTokens: usageTokens(message["usage"]),
    message: lastTextBlock(message["content"]),
  };
}

export interface FoldResult {
  figures: TranscriptFigures;
  malformed: number;
}

/** Applies lines in ascending line_no order on top of prev; newer values replace older ones. */
export function foldForward(
  prev: TranscriptFigures,
  lines: readonly { line_no: number; raw: string }[],
): FoldResult {
  let malformed = 0;
  let f = prev;
  for (const l of lines) {
    const r = readRow(l.raw, () => malformed++);
    f = {
      model: r.model ?? f.model,
      contextTokens: r.contextTokens ?? f.contextTokens,
      branch: r.branch ?? f.branch,
      message: r.message ?? f.message,
      maxLine: Math.max(f.maxLine, l.line_no),
    };
  }
  return { figures: f, malformed };
}

/** True once every figure has a value, so a backward scan can stop. */
export function isComplete(f: TranscriptFigures): boolean {
  return f.model !== null && f.contextTokens !== null && f.branch !== null && f.message !== null;
}

/** Applies lines in DESCENDING line_no order; a figure already set keeps its (newer) value. */
export function foldBackward(
  acc: TranscriptFigures,
  linesDesc: readonly { line_no: number; raw: string }[],
): FoldResult {
  let malformed = 0;
  let f = acc;
  for (const l of linesDesc) {
    if (isComplete(f) && f.maxLine >= 0) break;
    const r = readRow(l.raw, () => malformed++);
    f = {
      model: f.model ?? r.model,
      contextTokens: f.contextTokens ?? r.contextTokens,
      branch: f.branch ?? r.branch,
      message: f.message ?? r.message,
      maxLine: Math.max(f.maxLine, l.line_no),
    };
  }
  return { figures: f, malformed };
}
