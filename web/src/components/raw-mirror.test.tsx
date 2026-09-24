import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { RawMirror, RawMirrorAppearanceContext } from "./raw-mirror";

// The raw region under a lifted card is the same pane rows at the same 1.25 leading as the mirror,
// so a Powerline cap or a block there is a quarter of a row short too (lib/cell-glyphs.ts). A card's
// Terminal view that brought the step back would undo the mirror's fix exactly when a dialog lifts.
describe("RawMirror", () => {
  it.each([
    { foreground: "#112233", background: "" },
    { foreground: "", background: "#aabbcc" },
    { foreground: "#112233", background: "#aabbcc" },
  ])("keeps partial and full custom colors absolute: %j", (colors) => {
    const lines = splitLines(parseAnsi("plain\n\x1b[31mred\x1b[0m\n────\n\x1b[7minverse\x1b[0m"));
    const { container, rerender } = render(
      <RawMirrorAppearanceContext value={{ colors, nativeMirror: true }}>
        <RawMirror lines={lines} />
      </RawMirrorAppearanceContext>,
    );
    const pre = container.querySelector("pre")!;
    expect(pre.className).not.toContain("invert(1)");
    expect(pre).not.toHaveClass("terminal-muse");
    expect(pre.style.getPropertyValue("--terminal-foreground")).toBe(colors.foreground);
    expect(pre.style.getPropertyValue("--terminal-background")).toBe(colors.background);
    const spans = [...pre.querySelectorAll("span")];
    const leaf = (text: string) => spans.find((s) => s.textContent === text && !s.querySelector("span"))!;
    expect(leaf("red").style.color).toBe("var(--ansi-1)");
    expect(leaf("inverse").style.color).toBe("var(--terminal-background, #0a0a0a)");
    expect(leaf("────").style.color).toBe(colors.foreground ? "rgb(17, 34, 51)" : "var(--terminal-muted-fg, #a1a1a1)");
    rerender(
      <RawMirrorAppearanceContext value={{ colors: { foreground: "", background: "" }, nativeMirror: true }}>
        <RawMirror lines={lines} />
      </RawMirrorAppearanceContext>,
    );
    expect(pre).toHaveClass("terminal-muse");
    expect(pre.style.color).toBe("");
    expect(pre.style.backgroundColor).toBe("");
  });

  it("paints cell-filling characters and leaves the text as the terminal printed it", () => {
    const text = "\ue0b6CL\ue0b4 5h \u2588\u2588 91%";
    const { container } = render(<RawMirror lines={splitLines(parseAnsi(text))} />);

    expect(container.querySelectorAll(".cell-glyph")).toHaveLength(4);
    expect(container.querySelector("pre")!.textContent).toBe(text);
  });
});
