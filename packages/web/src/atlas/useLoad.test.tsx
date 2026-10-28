// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLoad } from "./useProjects";

describe("useLoad scope", () => {
  it("drops the previous scope's data and error immediately, keeps data across keys of one scope", async () => {
    const { result, rerender } = renderHook(
      ({ id, k }: { id: string; k: string }) =>
        useLoad(() => (id === "B" ? Promise.reject(new Error("404")) : Promise.resolve(id)), k, id),
      { initialProps: { id: "A", k: "A:1" } },
    );
    await waitFor(() => expect(result.current.data).toBe("A"));
    act(() => rerender({ id: "A", k: "A:2" }));
    expect(result.current.data).toBe("A");
    act(() => rerender({ id: "B", k: "B:1" }));
    expect(result.current.data).toBeNull();
    await waitFor(() => expect(result.current.error).toBe("404"));
    expect(result.current.data).toBeNull();
  });
});
