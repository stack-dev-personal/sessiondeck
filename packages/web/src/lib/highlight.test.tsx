// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Highlighted, matchRanges, queryTokens } from "./highlight";

describe("highlight", () => {
  it("tokenizes like the hub: letter and digit runs", () => {
    expect(queryTokens('Foo-bar "baz*" NEAR(x)')).toEqual(["foo", "bar", "baz", "near", "x"]);
  });
  it("merges overlapping ranges, case-insensitive, no regex", () => {
    expect(matchRanges("Alpha alphabet", ["alpha", "alphab"])).toEqual([
      [0, 5],
      [6, 12],
    ]);
    expect(matchRanges("a.b(c)", [".*", "(("])).toEqual([]);
  });
  it("wraps matches in <mark> and keeps hostile text as text", () => {
    const evil = "<img src=x onerror=alert(1)> img";
    const { container } = render(<Highlighted text={evil} tokens={["img"]} />);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.textContent).toBe(evil);
    expect(container.querySelectorAll("mark")).toHaveLength(2);
  });
});
