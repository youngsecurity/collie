import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { HeldPasteStrip } from "./held-paste-strip";

// Issue #134. The strip is the only way a held paste leaves the field, so each button must do
// exactly its own thing, and the line-by-line send must not exist where it would submit an answer.
function mount(allowLineByLine: boolean) {
  const handlers = { onOneLine: vi.fn(), onLineByLine: vi.fn(), onDiscard: vi.fn() };
  render(<HeldPasteStrip allowLineByLine={allowLineByLine} {...handlers} />);
  return handlers;
}

describe("HeldPasteStrip", () => {
  it("says nothing was sent and calls each handler once, and only its own", async () => {
    const user = userEvent.setup();
    const handlers = mount(true);
    expect(screen.getByText("Pasted text has line breaks. Nothing sent yet.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "One line" }));
    expect(handlers.onOneLine).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Line by line" }));
    expect(handlers.onLineByLine).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(handlers.onDiscard).toHaveBeenCalledTimes(1);

    expect(handlers.onOneLine).toHaveBeenCalledTimes(1);
    expect(handlers.onLineByLine).toHaveBeenCalledTimes(1);
  });

  it("offers no line-by-line send outside a shell", () => {
    mount(false);
    expect(screen.queryByRole("button", { name: "Line by line" })).toBeNull();
    expect(screen.getByRole("button", { name: "One line" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
  });
});
