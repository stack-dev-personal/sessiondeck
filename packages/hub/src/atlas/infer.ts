// R5.1 / R5.5. Pure project and phase inference. The hub runs on another machine than the sessions,
// so nothing here touches the filesystem: a worktree is recognized by its path shape alone.
import { createHash } from "node:crypto";

export interface InferredProject {
  /** Canonical repo root: forward slashes, no trailing slash, lower-cased when it is a Windows path. */
  key: string;
  /** Default display name: basename of the repo root, original case. */
  name: string;
  color: string;
  /** True when the input path was a worktree that rolled up to its repo. */
  rolledUp: boolean;
}

export const UNASSIGNED_KEY = "(unassigned)";

const PALETTE = [
  "#e5484d",
  "#f76808",
  "#ffb224",
  "#46a758",
  "#12a594",
  "#0090ff",
  "#3e63dd",
  "#8e4ec6",
  "#d6409f",
  "#978365",
  "#6f6d66",
  "#30a46c",
];

/** Deterministic default color for a project key. */
export function defaultColor(key: string): string {
  const h = createHash("sha1").update(key).digest();
  return PALETTE[h.readUInt16BE(0) % PALETTE.length]!;
}

/** Stable id for a project key: 128 bits of SHA-256 (the store still disambiguates a conflict). */
export function projectIdOf(key: string): string {
  return `p_${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

/**
 * C0, DEL, C1 controls, bidi formatting characters (U+200E, U+200F, U+061C, U+202A-202E,
 * U+2066-2069), zero-width characters (U+200B-U+200D, U+FEFF) and line/paragraph separators.
 */
const UNSAFE_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Strips control and bidi characters and trims. Applied to every user-visible label. */
export function cleanLabel(s: string): string {
  return s.replace(UNSAFE_CHARS, "").trim();
}

/** Separators to '/', WSL /mnt/<drive> to <drive>:, no duplicate or trailing slash, drive letter lower-cased. */
export function normalizeSeparators(p: string): string {
  let s = p
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");
  const wsl = s.match(/^\/mnt\/([a-zA-Z])(\/|$)/);
  if (wsl) s = `${wsl[1]!}:/${s.slice(wsl[0].length)}`;
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  if (/^[a-zA-Z]:/.test(s)) s = s[0]!.toLowerCase() + s.slice(1);
  return s;
}

const isWindows = (s: string): boolean => /^[a-z]:/.test(s);

/** Directory names under which a worktree lives inside the repo: <repo>/<marker...>/<name>. */
const INNER_MARKERS: string[][] = [[".claude", "worktrees"], [".worktrees"], [".git", "worktrees"]];
/** Sibling container suffixes: <parent>/<repo>-wt/<name> belongs to <parent>/<repo> (name is the last segment). */
const SIBLING_SUFFIXES = ["-wt", "-worktrees"];

/** Rolls a (separator-normalized) path up to its repo root. Returns the input when it is not a worktree. */
export function repoRootOf(norm: string): { root: string; rolledUp: boolean } {
  const segs = norm.split("/");
  const lower = segs.map((s) => s.toLowerCase());
  for (let i = 1; i < segs.length; i++) {
    for (const marker of INNER_MARKERS) {
      if (i + marker.length >= segs.length) continue; // needs a <name> after the marker
      if (marker.every((m, j) => lower[i + j] === m)) {
        const root = segs.slice(0, i).join("/");
        if (root !== "" && !/^[a-z]:$/.test(root)) return { root, rolledUp: true };
      }
    }
    // Sibling rule: only the parent of the FINAL segment (the worktree root itself), so a repo
    // that happens to be called foo-wt, or an early -wt segment, never rolls up.
    if (i === segs.length - 2) {
      const seg = segs[i]!;
      for (const suf of SIBLING_SUFFIXES) {
        if (seg.length > suf.length && lower[i]!.endsWith(suf)) {
          const root = [...segs.slice(0, i), seg.slice(0, seg.length - suf.length)].join("/");
          return { root, rolledUp: true };
        }
      }
    }
  }
  return { root: norm, rolledUp: false };
}

/** Project for a session: statusLine workspace.project_dir, else cwd. Null inputs fall to Unassigned. */
export function inferProject(
  projectDir: string | null | undefined,
  cwd: string | null | undefined,
): InferredProject {
  const src = [projectDir, cwd].find((x): x is string => typeof x === "string" && x.trim() !== "");
  if (src === undefined) {
    return {
      key: UNASSIGNED_KEY,
      name: "Unassigned",
      color: defaultColor(UNASSIGNED_KEY),
      rolledUp: false,
    };
  }
  const { root, rolledUp } = repoRootOf(normalizeSeparators(src));
  const key = isWindows(root) ? root.toLowerCase() : root;
  const base =
    root === "/"
      ? "/"
      : (root
          .split("/")
          .filter((s) => s !== "")
          .at(-1) ?? root);
  // Slice by code point so a surrogate pair is never split.
  const name = Array.from(cleanLabel(base)).slice(0, 80).join("").trim() || "project";
  return { key, name, color: defaultColor(key), rolledUp };
}

// "P5 ..." at the start of the name, or the word "phase" spelled out; "fix p95 latency" is not a phase.
// After "P<n>" a separator is required; a bare space is accepted unless a metric word follows.
const PHASE_NAME =
  /^P(\d{1,4})(?:\s*[:/.\-_]|$|\s+(?!(?:latency|ms|percentile|response|cpu|load|perf|performance|regression|slow|timeout|throughput|tail)\b))|\bphase\s*(\d{1,4})\b/i;
const PHASE_BRANCH = /^p(\d{1,4})\//i;

/** Default phase label: from the session name ("P5", "Phase 5"), else a p<n>/ branch prefix. */
export function inferPhase(
  sessionName: string | null | undefined,
  branch: string | null | undefined,
): string | null {
  const n = (sessionName ?? "").match(PHASE_NAME);
  const digits = n ? (n[1] ?? n[2]) : (branch ?? "").match(PHASE_BRANCH)?.[1];
  return digits !== undefined ? `P${Number(digits)}` : null;
}
