---
id: 'sessiondeck-design-system'
title: 'sessiondeck: Design system'
collection: 'sessiondeck'
type: planning
status: draft
created: 2026-10-08
---
# Design system

A monitoring surface, not a marketing page. The design question is "can I tell in 200 ms which session needs me," repeated for every pixel. Everything below serves that.

## 1. Principles

1. Attention is the primary axis. Sessions waiting on you outrank everything; the visual hierarchy follows the state machine, not the project.
2. Never color alone. Every state has a color, an icon, and a word. Every threshold has a number.
3. Stable geometry. Cards never change size when a value goes from null to a number or a session gains a subagent. Reserve the space.
4. Density is adjustable, hierarchy is not. Compact mode removes detail, not the ordering.
5. Dark first, light equal. You will run this next to terminals; both themes are tested, dark is the default.
6. Monospace for numbers and identifiers, proportional for words. Figures align; names read.

## 2. Tokens

CSS variables on `:root`, redefined under `[data-theme="light"]`. Tailwind reads them through `theme.extend.colors` so utility classes stay semantic (`bg-surface-1`, `text-state-waiting`).

```css
:root {
  /* surfaces */
  --bg: #0e1116;            --surface-1: #151a21;   --surface-2: #1c232c;   --surface-3: #242d38;
  --border: #2a3441;        --border-strong: #3b4858;
  /* text */
  --fg: #e6edf3;            --fg-muted: #9aa7b4;    --fg-faint: #7c8792;
  /* states (the state machine, in color) */
  --state-starting: #8b949e;    /* gray    ◌ */
  --state-working:  #58a6ff;    /* blue    ● */
  --state-waiting:  #f0b429;    /* amber   ▲  waiting_permission and waiting_input */
  --state-idle:     #3fb950;    /* green   ○ */
  --state-error:    #f85149;    /* red     ✖ */
  --state-ended:    #7f868f;    /* slate   ■ */
  --state-exited:   #a371f7;    /* violet  ◆  (unexpected exit, distinct from ended) */
  /* meters */
  --meter-ok:   #3fb950;  --meter-warn: #f0b429;  --meter-high: #f85149;  --meter-track: #2a3441;
  /* accents */
  --accent: #58a6ff;  --accent-attention: #f0b429;
  /* type */
  --font-ui: Inter, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "Cascadia Code", ui-monospace, monospace;
  --text-xs: 11px; --text-sm: 12.5px; --text-md: 14px; --text-lg: 16px; --text-xl: 20px;
  /* space (4px grid) */
  --s-1: 4px; --s-2: 8px; --s-3: 12px; --s-4: 16px; --s-6: 24px; --s-8: 32px;
  --radius: 6px; --radius-lg: 10px;
  /* motion */
  --t-fast: 120ms; --t-base: 200ms; --ease: cubic-bezier(.2,.7,.2,1);
}
[data-theme="light"] {
  --bg: #f6f8fa; --surface-1: #ffffff; --surface-2: #f0f3f6; --surface-3: #e6eaef;
  --border: #d0d7de; --border-strong: #afb8c1;
  --fg: #1f2328; --fg-muted: #59636e; --fg-faint: #6e757d;
  --state-working: #0969da; --state-waiting: #9a6700; --state-idle: #1a7f37; --state-error: #cf222e; --state-ended: #6e7781; --state-exited: #8250df; --state-starting: #6e757d;
  --meter-ok: #1a7f37; --meter-warn: #9a6700; --meter-high: #cf222e; --meter-track: #d0d7de;
  --accent: #0969da; --accent-attention: #9a6700;
}
```

Contrast: every `--state-*` and `--meter-*` on `--surface-1` must pass 4.5:1 for text and 3:1 for icons in both themes (checked in Phase 3 R3.7; the amber values above were chosen for that, do not lighten them).

## 3. State vocabulary

| State | Icon | Label | Color token | Motion |
|-------|------|-------|-------------|--------|
| starting | ◌ | Starting | state-starting | none |
| working | ● | Working · `tool:Bash` | state-working | 1.5 s soft pulse on the dot only |
| waiting_permission | ▲ | Needs permission | state-waiting | card border glows once (400 ms), then steady; badge stays |
| waiting_input | ▲ | Needs input · `question` / `plan` | state-waiting | same |
| idle | ○ | Idle · 4m | state-idle | none |
| error | ✖ | Error · `api` | state-error | none, badge |
| ended | ■ | Ended · `clear` | state-ended | card dims to 60% |
| exited | ◆ | Exited (no SessionEnd) | state-exited | card dims, badge |

Detail text after the dot is the `state_detail` from the snapshot. `prefers-reduced-motion` disables the pulse and glow.

## 4. Meters and thresholds

Meters are horizontal bars with the number beside them. Thresholds are the same in every meter so the eye learns one rule.

| Meter | Source | ok | warn | high | Text |
|-------|--------|----|------|------|------|
| Context | `context.used_pct` | < 60 | 60-80 | > 80 | `72%` of `200k`; `n/a` before first sample |
| 5h window | `rate_limits.five_hour` | < 60 | 60-85 | > 85 | `41%` · resets `in 2h 10m` |
| 7d window | `rate_limits.seven_day` | < 60 | 60-85 | > 85 | `63%` · resets `Tue` |
| Cost | `cost.usd` | no color | | | `$1.84` (history view adds burn rate) |
| Tasks | `tasks` | no color | | | `3/7` bar, no thresholds |

`exceeds_200k_tokens` adds a small `200k+` tag next to the context meter. Stale windows (past `resets_at`) show `n/a` with a hollow bar, never the old number.

## 5. Components

### 5.1 Session card (Phase 3)

```
┌─────────────────────────────────────────────────────────┐
│ ● Working · tool:Edit            bb2dash · feat/phase-3 │  identity row: state chip left, project · branch right
│ "Validate harvest against catalog"            stack-lap │  session name (AI title or /rename), host at right, faint
│ ctx ▓▓▓▓▓▓▓░░░ 72%   5h ▓▓▓▓░░░░░░ 41%   7d ▓▓▓▓▓▓░ 63% │  meter row, fixed widths
│ ▸ Editing src/harvest/validate.ts                        │  activity line: current tool target or last message (1 line)
│ ◦◦●  2 agents   tasks 3/7 ▓▓▓▓░░░░   $1.84   Opus·high  │  subagent dots, tasks, cost, model·effort
│ 12m since prompt · started 09:41                         │  footer, faint
└─────────────────────────────────────────────────────────┘
```

Fixed height: 6 rows. Compact form (one row): `● bb2dash · "Validate harvest…"   72%  41%  63%   2 agents  3/7`.

Rules: name truncates with ellipsis, never wraps. Meters keep width when `n/a`. Subagent dots cap at 5 then `+n`. Attention states add `box-shadow: 0 0 0 1px var(--accent-attention)` and move to the top group.

### 5.2 Detail drawer (Phase 3)

Right-side panel, 420 px, `Esc` closes. Sections in this order: state timeline (last 20 transitions), context sparkline (statusline samples), rate limits with reset countdowns, subagents table (type, tokens, context window, model, elapsed), tasks list, last prompt, last assistant message, git (branch, worktree, PR link), raw envelope tail (collapsed).

### 5.3 Content view (Phase 4)

Message list with left gutter role marks (`you`, `claude`, `sys`), tool calls as collapsible blocks with a one-line summary (`Edit src/x.ts +12 −3`), diffs in a two-tone unified view, thinking collapsed with a word count, subagent threads indented one level with their own state dot. Compaction boundary: a full-width hairline labeled `compacted · 148k → 31k`.

### 5.4 Board strip and layouts (Phases 3, 6)

Strip: one compact card per session in attention order, horizontally scrollable, 36 px tall, intended for the top edge of a layout or a second monitor. Layout panes have a 1 px `--border` gutter and a 28 px header with the pane type and a close/compact control.

### 5.5 Alerts

Attention transitions produce: top-group reorder, border accent, optional browser notification titled `<project> needs permission` with the tool name, optional 200 ms sound. One per transition; no repeats while the state persists. Settings expose each separately.

## 6. Typography and density

- UI 14 px / 1.45; cards use 12.5 px; footers 11 px.
- Numbers always `--font-mono` with `font-variant-numeric: tabular-nums`.
- Two density settings (comfortable: 6-row card; compact: 1-row) and nothing in between.

## 7. Keyboard

`c` compact board · `Shift+C` compact all panes · `j`/`k` move · `Enter` open · `Esc` close · `Ctrl+K` palette · `1-9` saved layouts · `/` search · `t` theme.

## 8. Icons

Lucide for UI chrome; state glyphs are the Unicode characters in section 3 rendered in `--font-mono` so they align with numbers (no icon font needed for states).

## 9. Theming for the vault later

If you later embed board widgets in Obsidian or the harness UI, the tokens above are the only coupling: ship `tokens.css` as a standalone file from `packages/web/src/styles/tokens.css`.
