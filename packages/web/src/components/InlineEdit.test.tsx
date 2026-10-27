import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { InlineEdit } from "./InlineEdit";

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("InlineEdit focus while saving", () => {
  it("keeps focus on the input during a save and after a failure", async () => {
    const d = deferred();
    const user = userEvent.setup();
    render(
      <InlineEdit value="a" label="Name" hint="h" maxLength={20} onSave={() => d.promise}>
        a
      </InlineEdit>,
    );
    await user.click(screen.getByRole("button", { name: "Name" }));
    const input = screen.getByRole("textbox", { name: "Name" });
    await user.type(input, "b{Enter}");
    expect(input).toHaveAttribute("aria-busy", "true");
    expect(input).toHaveAttribute("readonly");
    expect(input).toHaveFocus();
    d.reject(new Error("nope"));
    await screen.findByRole("alert");
    expect(input).toHaveFocus();
    expect(input).not.toHaveAttribute("readonly");
    expect(input).toHaveValue("ab");
    await waitFor(() => expect(input).toHaveFocus());
  });
});
