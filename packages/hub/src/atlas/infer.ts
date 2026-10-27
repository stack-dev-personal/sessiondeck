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

/** Stable short id for a project key. */
export function projectIdOf(key: string): string {
  return `p_${createHash("sha1").update(key).digest("hex").slice(0, 12)}`;
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
/** Sibling container suffixes: <parent>/<repo>-wt/<name> belongs to <parent>/<repo>. */
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
    // The container must be followed by the worktree name.
    if (i + 1 < segs.length && i >= 1) {
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
  const name =
    root === "/"
      ? "/"
      : (root
          .split("/")
          .filter((s) => s !== "")
          .at(-1) ?? root);
  return { key, name, color: defaultColor(key), rolledUp };
}

const PHASE_NAME = /\bP(?:hase)?\s*(\d+)\b/i;
const PHASE_BRANCH = /^p(\d+)\//i;

/** Default phase label: from the session name ("P5", "Phase 5"), else a p<n>/ branch prefix. */
export function inferPhase(
  sessionName: string | null | undefined,
  branch: string | null | undefined,
): string | null {
  const m = (sessionName ?? "").match(PHASE_NAME) ?? (branch ?? "").match(PHASE_BRANCH);
  return m ? `P${Number(m[1])}` : null;
}
