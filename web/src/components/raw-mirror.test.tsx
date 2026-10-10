import { fireEvent, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { paneLinkHandlers, PaneFileLinks, testFileOpener } from "@/test/file-links";
import { server } from "@/test/setup";

import { FileLinksProvider } from "./file-links";
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

  it("exposes the scrolling pre and preserves custom paint when wrapping is enabled", () => {
    const ref = createRef<HTMLPreElement>();
    const { container, rerender } = render(
      <RawMirrorAppearanceContext value={{ colors: { foreground: "#00ff00", background: "#000000" } }}>
        <RawMirror lines={splitLines(parseAnsi("a long command"))} wrap className="max-h-40" ref={ref} />
      </RawMirrorAppearanceContext>,
    );
    expect(ref.current).toBe(container.querySelector("pre"));
    expect(ref.current).toHaveClass("whitespace-pre-wrap", "wrap-anywhere", "max-h-40");
    expect(ref.current).not.toHaveClass("overflow-x-auto");
    expect(ref.current).toHaveStyle({ color: "#00ff00", backgroundColor: "#000000" });
    rerender(<RawMirror lines={splitLines(parseAnsi("a long command"))} ref={ref} />);
    expect(ref.current).toHaveClass("overflow-x-auto", "whitespace-pre");
    expect(ref.current?.className).toContain("invert(1)");
  });

  it("paints cell-filling characters and leaves the text as the terminal printed it", () => {
    const text = "\ue0b6CL\ue0b4 5h \u2588\u2588 91%";
    const { container } = render(<RawMirror lines={splitLines(parseAnsi(text))} />);

    expect(container.querySelectorAll(".cell-glyph")).toHaveLength(4);
    expect(container.querySelector("pre")!.textContent).toBe(text);
  });
});

// A path the agent printed is a link in a card's Terminal view too (ADR 0088), found per row.
describe("RawMirror file paths", () => {
  const mirror = (text: string, opened: string[]) =>
    render(
      <FileLinksProvider value={testFileOpener(opened)}>
        <RawMirror lines={splitLines(parseAnsi(text))} />
      </FileLinksProvider>,
    );

  it("a row with a path under the root wraps it in a link that keeps the agent's colours", () => {
    const opened: string[] = [];
    const text = "  \x1b[32m+ edited src/cart.ts:7\x1b[0m done\nnext row";
    const { container } = mirror(text, opened);
    const link = container.querySelector("a")!;
    expect(link.textContent).toBe("src/cart.ts:7");
    // The green the agent printed, on the link's own text as on the words before it.
    expect(link.querySelector("span")?.getAttribute("style")).toContain("--ansi-2");
    // The rows read exactly as the terminal printed them.
    expect(container.querySelector("pre")!.textContent).toBe("  + edited src/cart.ts:7 done\nnext row");
    fireEvent.click(link);
    expect(opened).toEqual(["/pane/w1%3Ap1/changes/files?path=src%2Fcart.ts&line=7"]);
  });

  it.each([
    { foreground: "#112233", background: "" },
    { foreground: "", background: "#aabbcc" },
    { foreground: "#112233", background: "#aabbcc" },
  ])("preserves custom paint and segment hints across linked slices: %j", (colors) => {
    const opened: string[] = [];
    const lines = splitLines(parseAnsi("before src/cart.ts after"));
    for (const line of lines) {
      for (const segment of line.segments) {
        segment.muted = true;
        segment.mobileTransparentBg = true;
        segment.style = { ...segment.style, backgroundColor: "rgb(240,240,240)" };
      }
    }
    const { container } = render(
      <RawMirrorAppearanceContext value={{ colors, nativeMirror: true }}>
        <FileLinksProvider value={testFileOpener(opened)}>
          <RawMirror lines={lines} />
        </FileLinksProvider>
      </RawMirrorAppearanceContext>,
    );
    const pre = container.querySelector("pre")!;
    expect(pre.className).not.toContain("invert(1)");
    expect(pre).not.toHaveClass("terminal-muse");
    expect(pre.style.getPropertyValue("--terminal-foreground")).toBe(colors.foreground);
    expect(pre.style.getPropertyValue("--terminal-background")).toBe(colors.background);
    expect(pre.textContent).toBe("before src/cart.ts after");
    const slices = pre.querySelectorAll<HTMLElement>(".terminal-muted");
    expect(slices).toHaveLength(3);
    for (const slice of slices) {
      expect(slice.style.color).toBe(colors.foreground ? "rgb(17, 34, 51)" : "var(--terminal-muted-fg, #a1a1a1)");
      expect(slice).toHaveClass("terminal-mobile-transparent-bg");
      expect(slice.style.backgroundColor).toBe("");
      expect(slice.style.getPropertyValue("--terminal-seg-bg")).toBe("rgb(240,240,240)");
    }
    fireEvent.click(pre.querySelector("a")!);
    expect(opened).toEqual(["/pane/w1%3Ap1/changes/files?path=src%2Fcart.ts"]);
  });

  it("keeps explicit native foreground hints on file-linked text with and without custom paint", () => {
    const lines = splitLines(parseAnsi("\u001b[38;2;240;240;240msrc/cart.ts\u001b[0m"));
    for (const line of lines) {
      for (const segment of line.segments) segment.lightDarkFg = true;
    }
    const body = <FileLinksProvider value={testFileOpener([])}><RawMirror lines={lines} /></FileLinksProvider>;
    const { container, rerender } = render(
      <RawMirrorAppearanceContext value={{ nativeMirror: true }}>{body}</RawMirrorAppearanceContext>,
    );
    const pre = container.querySelector("pre")!;
    expect(pre).toHaveClass("terminal-muse");
    const span = pre.querySelector("a span")!;
    expect(span).toHaveClass("terminal-light-dark-fg");
    expect(span.getAttribute("style")).toContain("var(--terminal-light-dark-fg, rgb(240,240,240))");
    rerender(
      <RawMirrorAppearanceContext value={{ nativeMirror: true, colors: { foreground: "#00ff00", background: "#000000" } }}>
        {body}
      </RawMirrorAppearanceContext>,
    );
    expect(pre).not.toHaveClass("terminal-muse");
    expect(span.getAttribute("style")).toContain("var(--terminal-light-dark-fg, rgb(240,240,240))");
  });

  it("through the pane's real opener, a path the bridge did not say exists stays text", async () => {
    const asked: string[][] = [];
    server.use(...paneLinkHandlers(["src/cart.ts"], asked));
    const { container } = render(
      <MemoryRouter>
        <PaneFileLinks>
          <RawMirror lines={splitLines(parseAnsi("edited src/cart.ts\nread architecture/notes.md"))} />
        </PaneFileLinks>
      </MemoryRouter>,
    );
    expect(container.querySelector("a")).toBeNull();
    await waitFor(() => expect(container.querySelector("a")?.textContent).toBe("src/cart.ts"));
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(asked).toEqual([["src/cart.ts", "architecture/notes.md"]]);
  });

  it("a path outside the root stays plain text", () => {
    const { container } = mirror("cat /etc/hosts and ~/.ssh/config", []);
    expect(container.querySelector("a")).toBeNull();
  });

  it("with no opener, nothing is a link", () => {
    const { container } = render(<RawMirror lines={splitLines(parseAnsi("see src/cart.ts"))} />);
    expect(container.querySelector("a")).toBeNull();
  });
});
