import type { SessionSnapshot } from "@sessiondeck/contract";
import { archiveOf, isArchivedState, outcomeExcerpt } from "../atlas/types";
import { displayNameOf } from "../lib/attention";
import { formatDuration } from "../lib/format";
import { neutralize } from "../lib/neutralize";
import { ARCHIVED_VOCAB } from "../lib/state-vocab";

/** Marks a record that has a vault capture attached: icon, label and color, never color alone. */
export function ArchivedBadge() {
  return (
    <span data-slot="archived-badge" className={`num shrink-0 ${ARCHIVED_VOCAB.textClass}`}>
      <span aria-hidden="true">{ARCHIVED_VOCAB.glyph}</span> {ARCHIVED_VOCAB.label}
    </span>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Row title: the live name, else the capture's title, else the project (all neutralized). */
export function rowName(s: SessionSnapshot): string {
  const a = archiveOf(s);
  if (!s.session_name && a?.title) return a.title;
  return displayNameOf(s);
}

/** Branch for rows, neutralized: the live branch, else the one the capture recorded; null when unknown. */
export const branchOf = (s: SessionSnapshot): string | null =>
  s.git.branch ? neutralize(s.git.branch) : (archiveOf(s)?.branch ?? null);

/** `branchOf`, with "n/a" for unknown. */
export const branchText = (s: SessionSnapshot): string => branchOf(s) ?? "n/a";

/**
 * One line for a session with an archive record: Archived badge (only while the state cell does not already show it), duration, commit and PR counts,
 * outcome excerpt. Plain React text only. Renders nothing for a session without a record, so a
 * merged record stays one row. `prefix` text (e.g. the host) goes first.
 */
export function ArchiveLine({ s, prefix }: { s: SessionSnapshot; prefix?: string }) {
  const a = archiveOf(s);
  if (a === null) return null;
  const excerpt = outcomeExcerpt(a.outcome);
  const name = rowName(s);
  const title = a.title !== null && a.title !== name ? a.title : null;
  return (
    <span
      data-slot="archive-line"
      className="flex min-w-0 items-center gap-s-2 overflow-hidden text-xs text-fg-muted"
      title={a.outcome === "" ? undefined : a.outcome}
    >
      {prefix ? <span className="num shrink-0">{prefix}</span> : null}
      {isArchivedState(s) ? null : <ArchivedBadge />}
      <span className="num shrink-0" data-slot="duration">
        {a.durationS === null ? "n/a" : formatDuration(a.durationS * 1000)}
      </span>
      <span className="num shrink-0" data-slot="commits">
        {plural(a.commits.length, "commit", "commits")}
      </span>
      <span className="num shrink-0" data-slot="prs">
        {plural(a.prs.length, "PR", "PRs")}
      </span>
      {title !== null ? <span className="shrink-0 text-fg">{title}</span> : null}
      <span className="min-w-0 truncate" data-slot="outcome">
        {excerpt === "" ? "no outcome recorded" : excerpt}
      </span>
    </span>
  );
}
