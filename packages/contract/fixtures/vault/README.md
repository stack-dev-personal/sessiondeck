# Vault capture fixtures (SYNTHETIC)

These files are SYNTHETIC captures modeled on the phase-5 field list (`docs/planning/phases/phase-5-atlas.md`). The real vault was not reachable in the sprint container, so nothing here was copied from a real capture. OPEN ITEM for the user: confirm the real format by copying one scrubbed real `harness/agentic-harness/sessions/*.md` file in, diffing its frontmatter against the shape below, and adjusting the parser and goldens if they differ. All data is fake (`C:/Users/dev/...`, invented commit ids and titles).

## Layout

```
vault/harness/agentic-harness/sessions/*.md   20 files, schema_version 2
vault/projects/sessiondeck/sessions/*.md      2 files, the other root pattern
vault/expected/<same relative path>.md.json   golden ArchivePayload per file
../vault-edge/harness/agentic-harness/sessions/   edge cases, not part of the 22
```

Line endings and the BOM are part of the fixtures: `fixtures/.gitattributes` marks `vault/` and `vault-edge/` as `-text` so git does not rewrite them. Do not reformat these files.

## Expected frontmatter shape

A YAML block between `---` lines at the very start of the file (after an optional UTF-8 BOM), then a markdown body.

```
schema_version: 2
session_id: <uuid>                  required; quoted or unquoted
title: <string>                     optional
date: <ISO date or datetime>        e.g. 2026-09-01 or 2026-09-01T14:05:00Z (read as a string, never a Date)
started_at / ended_at: <ISO>        optional
duration: <seconds | "1h 23m" | "45m">   or duration_s: <seconds>
cwd or project_dir: <path>          optional; project_dir wins when both exist
branch: <string>                    optional
tools_used: names or name: count    see below
commits: [..] or block list
prs: [..] or block list
```

## Normalizations a correct parser applies

- BOM stripped; CRLF treated as LF; body (outcome) is trimmed and uses LF.
- `duration` / `duration_s`: numbers are seconds; `Nh Mm`, `Nh`, `Nm` strings are converted to seconds.
- `tools_used` becomes `[{name, count}]`: a list of names gives `count: null`; `name: count` maps (block map, flow map `{a: 1}`, or a block list of single-key maps `- a: 1`) give the integer. An empty list gives `[]`.
- `project_dir` = frontmatter `project_dir`, else `cwd`, else null. Missing optional fields give null (`started_at`, `ended_at`, `title`, `branch`) or `[]` (`commits`, `prs`).
- `collection` is the first two path segments: `projects/<x>` or `harness/<x>`.
- `source.root_label` is `vault`. Goldens omit `source.mtime_ms` and `source.size` (they vary by checkout).
- `outcome_truncated` is false in all goldens.

## Live-plus-archive overlap

Three files use session_ids that also appear in the live contract fixtures (SessionStart, Stop, UserPromptSubmit), for merge tests:

- `2026-09-02-1300-reducer-fix.md`: a9648976-1965-4d5a-8cf8-eb285b22406f
- `2026-09-03-1530-installer.md`: fc727a7b-bc64-4de4-8767-4a0a61457910
- `2026-09-06-0800-live-three.md`: 8cc38311-7274-400a-8426-a201e49b8e4f

## Shape variety covered

Block list, flow list, block map, flow map and list-of-maps `tools_used`; quoted and unquoted strings; date-only and datetime with `Z` or an offset; CRLF (`reducer-fix`, `crlf-two`); BOM (`bom-case`); multi-line markdown outcome (`multiline`); empty `prs` and `commits`; empty `tools_used` and a missing title (`no-tools`); `duration_s` key (`duration-s`); Unicode in the body (`unicode`).

## Edge cases (`fixtures/vault-edge/`)

Expected importer behavior, no goldens: `no-frontmatter.md`, `no-session-id.md` and `unterminated.md` are skipped and counted as skipped; `oversized-outcome.md` (about 22 KB body) imports with `outcome` cut to 16384 chars and `outcome_truncated: true`; `notes.txt` is ignored (only `.md` is read).
