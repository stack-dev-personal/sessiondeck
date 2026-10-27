import { describe, expect, it } from "vitest";
import { buildPreset, PRESET_NAMES, type PresetName } from "./presets";
import {
  MAX_DEPTH,
  MAX_PANES,
  normalize,
  panesOf,
  parse,
  serialize,
  validate,
  type LayoutSpec,
  type Node,
} from "./spec";

const pane = (id: string, type = "session"): Node => ({ kind: "pane", id, type }) as Node;

const handMade: LayoutSpec[] = [
  {
    version: 1,
    id: "h1",
    name: "odd ratios",
    root: {
      kind: "split",
      dir: "row",
      ratios: [0.1234567891234, 0.3765432108766, 0.5],
      children: [
        pane("a", "board"),
        { kind: "pane", id: "b", type: "session", sessionId: "s-1", compact: true },
        {
          kind: "split",
          dir: "column",
          ratios: [1 / 3, 2 / 3],
          children: [
            { kind: "pane", id: "c", type: "project", projectDir: "web" },
            pane("d", "metrics"),
          ],
        },
      ],
    },
  },
  { version: 1, id: "h2", name: "single", root: pane("only", "metrics") },
];

const presets: [string, LayoutSpec][] = PRESET_NAMES.map((n) => [
  n,
  buildPreset(n, ["alpha", "beta", "gamma"]),
]);

describe("spec round trip (golden)", () => {
  it.each([...presets, ...handMade.map((s) => [s.id, s] as [string, LayoutSpec])])(
    "%s survives serialize then parse with identical ratios and pane types",
    (_n, spec) => {
      const text = serialize(spec);
      const back = parse(text);
      expect(back.ok).toBe(true);
      if (!back.ok) return;
      expect(back.spec).toEqual(spec);
      expect(serialize(back.spec)).toBe(text);
      expect(panesOf(back.spec).map((p) => p.type)).toEqual(panesOf(spec).map((p) => p.type));
    },
  );

  it("keeps non-terminating ratios bit for bit", () => {
    const r = [1 / 3, 1 / 3, 1 / 3];
    const spec: LayoutSpec = {
      version: 1,
      id: "t",
      name: "t",
      root: { kind: "split", dir: "row", ratios: r, children: [pane("a"), pane("b"), pane("c")] },
    };
    const back = parse(serialize(spec));
    expect(back.ok && back.spec.root.kind === "split" && back.spec.root.ratios).toEqual(r);
  });
});

describe("validation", () => {
  const base = (root: unknown) => ({ version: 1, id: "x", name: "x", root });
  const split = (ratios: unknown, children: unknown[] = [pane("a"), pane("b")]) => ({
    kind: "split",
    dir: "row",
    ratios,
    children,
  });

  it("accepts a sane spec", () => {
    expect(validate(base(split([0.5, 0.5]))).ok).toBe(true);
  });
  it.each([
    ["ratio sum off", base(split([0.5, 0.4]))],
    ["negative ratio", base(split([-0.5, 1.5]))],
    ["zero ratio", base(split([0, 1]))],
    ["NaN ratio", base(split([Number.NaN, 0.5]))],
    ["string ratio", base(split(["0.5", "0.5"]))],
    ["ratio count mismatch", base(split([1]))],
    ["unknown pane type", base({ kind: "pane", id: "a", type: "terminal" })],
    ["bad dir", base({ ...split([0.5, 0.5]), dir: "diagonal" })],
    ["unknown kind", base({ kind: "tab" })],
    ["bad version", { ...base(pane("a")), version: 2 }],
    ["duplicate pane id", base(split([0.5, 0.5], [pane("a"), pane("a")]))],
    ["empty id", base(pane(""))],
    ["non object", 42],
    ["single child split", base(split([1], [pane("a")]))],
  ])("rejects %s", (_n, input) => {
    expect(validate(input).ok).toBe(false);
  });

  it("allows a sum within tolerance and normalize makes it exact", () => {
    const r = validate(base(split([0.5, 0.5004])));
    expect(r.ok).toBe(true);
    if (!r.ok || r.spec.root.kind !== "split") return;
    const n = normalize(r.spec);
    const sum = (n.root as { ratios: number[] }).ratios.reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-12);
  });

  it("rejects trees deeper than the cap", () => {
    let node: unknown = pane("leaf");
    for (let i = 0; i <= MAX_DEPTH; i++)
      node = { kind: "split", dir: "row", ratios: [0.5, 0.5], children: [node, pane(`x${i}`)] };
    expect(validate(base(node)).ok).toBe(false);
  });

  it("rejects more panes than the cap", () => {
    const kids = Array.from({ length: MAX_PANES + 1 }, (_, i) => pane(`p${i}`));
    const rows = [kids.slice(0, 8), kids.slice(8)].map((c) =>
      split(
        c.map(() => 1 / c.length),
        c,
      ),
    );
    expect(validate(base({ ...split([0.5, 0.5], rows), dir: "column" })).ok).toBe(false);
  });

  it("rejects bad JSON text without throwing", () => {
    expect(parse("{nope").ok).toBe(false);
  });
});

describe("preset shapes", () => {
  const shape = (n: PresetName, projects: string[] = []) => {
    const s = buildPreset(n, projects);
    return panesOf(s).map((p) => p.type);
  };
  it("solo is a strip over one content pane", () => {
    expect(shape("solo")).toEqual(["board", "session"]);
  });
  it("pair has two content panes", () => expect(shape("pair")).toEqual(["session", "session"]));
  it("quad has four", () => expect(shape("quad")).toHaveLength(4));
  it("focus has one large (70%) and three small", () => {
    const s = buildPreset("focus");
    expect(panesOf(s)).toHaveLength(4);
    expect(s.root.kind === "split" && s.root.ratios).toEqual([0.7, 0.3]);
  });
  it("grid6 has six", () => expect(shape("grid6")).toEqual(Array(6).fill("session")));
  it("strip is the compact board only", () => expect(shape("strip")).toEqual(["board"]));
  it("by-project makes one project pane per distinct project, sorted", () => {
    const s = buildPreset("by-project", ["web", "hub", "web"]);
    expect(panesOf(s).map((p) => p.projectDir)).toEqual(["hub", "web"]);
    expect(shape("by-project", ["a", "b", "c"])).toEqual(["project", "project", "project"]);
  });
  it("by-project with no projects still renders one unassigned project pane", () => {
    expect(panesOf(buildPreset("by-project", []))).toEqual([
      { kind: "pane", id: "p0", type: "project" },
    ]);
  });
  it("by-project is capped below the pane limit", () => {
    const many = Array.from({ length: 40 }, (_, i) => `p${String(i).padStart(2, "0")}`);
    const s = buildPreset("by-project", many);
    expect(panesOf(s).length).toBeLessThanOrEqual(MAX_PANES);
    expect(validate(s).ok).toBe(true);
  });
  it("every preset is valid, deterministic and has unique pane ids", () => {
    for (const n of PRESET_NAMES) {
      const a = buildPreset(n, ["x", "y"]);
      expect(validate(a).ok).toBe(true);
      expect(buildPreset(n, ["x", "y"])).toEqual(a);
      const idsList = panesOf(a).map((p) => p.id);
      expect(new Set(idsList).size).toBe(idsList.length);
    }
  });
});
