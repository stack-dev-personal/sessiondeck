/**
 * The seven builtin presets (R6.1). Each is a pure function of its inputs (only by-project takes
 * the project list), so the same inputs always give the same spec and the golden tests can pin them.
 */
import {
  MAX_PANES,
  type LayoutSpec,
  type Node,
  type Pane,
  type PaneType,
  type Split,
} from "./spec";

export const PRESET_NAMES = [
  "solo",
  "pair",
  "quad",
  "focus",
  "grid6",
  "by-project",
  "strip",
] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export const PRESET_LABELS: Record<PresetName, string> = {
  solo: "Solo: one session and the strip",
  pair: "Pair: two side by side",
  quad: "Quad: 2 by 2",
  focus: "Focus: one large, three small",
  grid6: "Grid: 2 by 3",
  "by-project": "By project: a column per project",
  strip: "Strip: compact board only",
};

export function isPresetName(v: unknown): v is PresetName {
  return typeof v === "string" && (PRESET_NAMES as readonly string[]).includes(v);
}

/** Share of the height given to the strip pane in solo. The pane also has a 64 px floor (28 + 36). */
const STRIP_SHARE = 0.07;

function ids() {
  let n = 0;
  const pane = (type: PaneType, extra: Partial<Pane> = {}): Pane => ({
    kind: "pane",
    id: `p${n++}`,
    type,
    ...extra,
  });
  return pane;
}

const even = (n: number): number[] => Array.from({ length: n }, () => 1 / n);
const split = (dir: Split["dir"], children: Node[], ratios = even(children.length)): Split => ({
  kind: "split",
  dir,
  ratios,
  children,
});

/** Projects beyond this many are not given a column (the route shows "+N more"); keeps panes under MAX_PANES. */
export const MAX_PROJECT_COLUMNS = MAX_PANES - 4;

/**
 * `projects` are full project dirs in the order the caller wants them (by-project keeps the first
 * MAX_PROJECT_COLUMNS; the route passes attention order). Other presets ignore it.
 */
export function buildPreset(name: PresetName, projects: readonly string[] = []): LayoutSpec {
  const pane = ids();
  const make = (root: Node): LayoutSpec => ({
    version: 1,
    id: name,
    name: PRESET_LABELS[name].split(":")[0]!,
    root,
  });
  switch (name) {
    case "solo":
      return make(
        split("column", [pane("board"), pane("session")], [STRIP_SHARE, 1 - STRIP_SHARE]),
      );
    case "pair":
      return make(split("row", [pane("session"), pane("session")]));
    case "quad":
      return make(
        split("column", [
          split("row", [pane("session"), pane("session")]),
          split("row", [pane("session"), pane("session")]),
        ]),
      );
    case "focus":
      return make(
        split(
          "row",
          [pane("session"), split("column", [pane("session"), pane("session"), pane("session")])],
          [0.7, 0.3],
        ),
      );
    case "grid6":
      return make(
        split("column", [
          split("row", [pane("session"), pane("session"), pane("session")]),
          split("row", [pane("session"), pane("session"), pane("session")]),
        ]),
      );
    case "by-project": {
      const list = [...new Set(projects)].slice(0, MAX_PROJECT_COLUMNS);
      if (list.length === 0) return make(pane("project"));
      if (list.length === 1) return make(pane("project", { projectDir: list[0]! }));
      return make(
        split(
          "row",
          list.map((p) => pane("project", { projectDir: p })),
        ),
      );
    }
    case "strip":
      return make(pane("board"));
  }
}
