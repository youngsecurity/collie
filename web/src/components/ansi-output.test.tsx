import { render, screen } from "@testing-library/react";

import { AnsiOutput } from "./ansi-output";

const ESC = "\x1b";

describe("AnsiOutput — terminal appearance", () => {
  it("applies the configured font and default colors to terminal output", () => {
    const { container } = render(
      <AnsiOutput
        text="plain"
        appearance={{
          fontFamily: "MesloLGS NF",
          foreground: "#00ff00",
          background: "#000000",
        }}
      />,
    );

    expect(container.querySelector("pre")).toHaveStyle({
      fontFamily: "MesloLGS NF, var(--font-mono)",
      color: "#00ff00",
      backgroundColor: "#000000",
    });
  });

  it("keeps explicit ANSI truecolor authoritative over the configured default foreground", () => {
    render(
      <AnsiOutput
        text={`plain ${ESC}[38;2;255;165;216mexplicit${ESC}[0m`}
        appearance={{
          fontFamily: "MesloLGS NF",
          foreground: "#00ff00",
          background: "#000000",
        }}
      />,
    );

    expect(screen.getByText("explicit")).toHaveStyle({ color: "rgb(255, 165, 216)" });
  });

  it("preserves explicit ANSI on muted rules and otherwise uses the configured foreground", () => {
    render(
      <AnsiOutput
        text={`${ESC}[38;2;255;165;216m────${ESC}[0m\n────`}
        appearance={{
          fontFamily: "MesloLGS NF",
          foreground: "#00ff00",
          background: "#000000",
        }}
      />,
    );

    const rules = screen.getAllByText("────");
    expect(rules[0]).toHaveStyle({ color: "rgb(255, 165, 216)" });
    expect(rules[1]).toHaveStyle({ color: "#00ff00" });
  });

  it("inherits the Collie theme when appearance values are empty", () => {
    const { container } = render(
      <AnsiOutput
        text="────"
        appearance={{ fontFamily: "", foreground: "", background: "" }}
      />,
    );

    const pre = container.querySelector("pre");
    expect(pre).not.toHaveStyle({ fontFamily: "MesloLGS NF" });
    expect(pre).not.toHaveStyle({ color: "#00ff00" });
    expect(pre).not.toHaveStyle({ backgroundColor: "#000000" });
    expect(screen.getByText("────")).toHaveStyle({ color: "var(--muted-foreground)" });
  });
});
