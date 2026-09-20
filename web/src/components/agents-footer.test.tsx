import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { AgentsFooter } from "./agents-footer";
import { mirrorSurface } from "@/hooks/use-display-prefs";

const FACE = mirrorSurface({ fontFamily: "system", terminalForeground: "", terminalBackground: "" });
const rows = (text: string) => splitLines(parseAnsi(text));

describe("AgentsFooter (issue #242)", () => {
  it("shows the first agent under the header, and a count of the rest, until tapped", () => {
    render(
      <AgentsFooter
        rows={rows("  ● main\n  ◯ worker:scout  Reviewing tests  1m\n  ◯ worker:fixer  Patching  20s")}
        face={FACE}
      />,
    );
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveTextContent("worker:scout");
    expect(button).toHaveTextContent("+1");
    expect(screen.queryByText(/● main/)).toBeNull();
    expect(screen.queryByText(/worker:fixer/)).toBeNull();
  });

  it("shows every row, header first, when tapped", () => {
    render(
      <AgentsFooter
        rows={rows("  ● main\n  ◯ worker:scout  Reviewing tests  1m\n  ◯ worker:fixer  Patching  20s")}
        face={FACE}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/● main/)).toBeInTheDocument();
    expect(screen.getByText(/worker:scout/)).toBeInTheDocument();
    expect(screen.getByText(/worker:fixer/)).toBeInTheDocument();
  });

  it("shows no count for a single agent", () => {
    render(<AgentsFooter rows={rows("  ● main\n  ◯ worker:scout  Reviewing tests  1m")} face={FACE} />);
    expect(screen.getByRole("button")).not.toHaveTextContent("+");
  });

  it.each([false, true])("preserves the mirror color policy (custom: %s)", (custom) => {
    const face = custom
      ? mirrorSurface({ fontFamily: "system", terminalForeground: "#00ff00", terminalBackground: "#000000" })
      : FACE;
    const { container } = render(<AgentsFooter rows={rows("  ● main\n  ◯ worker:scout")} face={face} />);
    const footer = container.firstElementChild;
    if (custom) {
      expect(footer).toHaveStyle({ color: "#00ff00", backgroundColor: "#000000" });
      expect(footer?.className).not.toContain("[filter:invert(1)_hue-rotate(180deg)]");
    } else {
      expect(footer?.className).toContain("[filter:invert(1)_hue-rotate(180deg)]");
    }
  });

  it("renders nothing for no rows", () => {
    const { container } = render(<AgentsFooter rows={[]} face={FACE} />);
    expect(container).toBeEmptyDOMElement();
  });
});
