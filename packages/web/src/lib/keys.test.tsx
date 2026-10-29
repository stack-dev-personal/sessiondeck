// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUi } from "../store/ui";
import { keyName, useShortcuts } from "./keys";

function Harness({ map }: { map: Record<string, () => void> }) {
  useShortcuts(map);
  return null;
}

beforeEach(() => useUi.setState({ modalOpen: false, selectedSessionId: null }));

describe("keyName (finding 8)", () => {
  it("takes the case of a letter from Shift, not from Caps Lock", () => {
    expect(keyName({ key: "C", shiftKey: false })).toBe("c"); // Caps Lock, no Shift
    expect(keyName({ key: "c", shiftKey: true })).toBe("C"); // Caps Lock + Shift
    expect(keyName({ key: "C", shiftKey: true })).toBe("C");
    expect(keyName({ key: "c", shiftKey: false })).toBe("c");
  });
  it("leaves digits and named keys alone", () => {
    expect(keyName({ key: "1", shiftKey: false })).toBe("1");
    expect(keyName({ key: "Escape", shiftKey: false })).toBe("Escape");
  });
});

describe("useShortcuts", () => {
  it("with Caps Lock on, Shift+C is compact-all and plain c is the lowercase key", () => {
    const lower = vi.fn();
    const upper = vi.fn();
    render(<Harness map={{ c: lower, C: upper }} />);
    fireEvent.keyDown(window, { key: "C", code: "KeyC", shiftKey: false }); // plain c, Caps Lock
    expect(lower).toHaveBeenCalledTimes(1);
    expect(upper).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "c", code: "KeyC", shiftKey: true }); // Shift+c, Caps Lock
    expect(upper).toHaveBeenCalledTimes(1);
  });

  it("finding 7: nothing fires while a modal is open", () => {
    const t = vi.fn();
    render(<Harness map={{ t }} />);
    useUi.setState({ modalOpen: true });
    fireEvent.keyDown(window, { key: "t" });
    expect(t).not.toHaveBeenCalled();
    useUi.setState({ modalOpen: false });
    fireEvent.keyDown(window, { key: "t" });
    expect(t).toHaveBeenCalledTimes(1);
  });
});
