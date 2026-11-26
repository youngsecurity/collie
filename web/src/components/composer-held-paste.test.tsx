import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import { clearStatus } from "@/lib/status";
import type { Surface } from "@/lib/surface/surface";
import { server } from "@/test/setup";
import { Composer } from "./composer";

// Issue #134, at the composer: a paste with line breaks into Type mode is held, and what the strip
// offers depends on the SCREEN the pane shows. The line-break key is offered where it was measured to
// add a line and do nothing else (pi's stock answer editor) and nowhere else, because on any other
// screen the same key may be an Enter, or, in pi's own editor, the key that accepts a completion and
// rewrites the line. The hook's own rules are in use-direct-typing.test.

vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => true,
  useLive: () => true,
}));

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => clearStatus());

const PANES_DIR = join(import.meta.dirname, "..", "fixtures", "panes");
const screenOf = (name: string): string => readFileSync(join(PANES_DIR, `${name}.txt`), "utf8");
/** A modal the phone cannot type into: what the bridge reads while a pi question is open. */
const MODAL: Surface = { revision: 2, turn: "idle", modal: "unreadable", composer: "unknown" };
const PASTE = "first line\nsecond line\nthird";

/** Mount on a pane showing `text`, arm Type mode, paste three lines. Answers the keys the pane got. */
function pasteInto(over: Partial<ComponentProps<typeof Composer>>) {
  const keys: string[] = [];
  server.use(
    http.post<never, { keys: string[] }>(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
      keys.push(...(await request.json()).keys);
      return HttpResponse.json({ ok: true });
    }),
  );
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1",
    agent: "pi",
    isShell: false,
    gone: false,
    readOnly: false,
    surface: MODAL,
    text: "pane output",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: { terminalForeground: "", terminalBackground: "", wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false },
    display: { open: false, onToggle: () => undefined },
    onSent: () => undefined,
    ...over,
  };
  const router = createMemoryRouter([{ path: "/", element: <Composer {...props} /> }]);
  render(<RouterProvider router={router} />);
  fireEvent.click(screen.getByRole("button", { name: /^type into terminal$/i }));
  const box = screen.getByPlaceholderText(/type into the terminal/i);
  fireEvent.change(box, { target: { value: PASTE } });
  return { box, keys };
}

const offered = () =>
  ["Keep lines", "One line", "Line by line", "Discard"].filter((name) => screen.queryByRole("button", { name }) !== null);

describe("Composer: a held paste and the screen it would go to (issue #134)", () => {
  it("keeps the lines in pi's answer editor: the line-break key at each break, then one Enter from the person", async () => {
    const { box, keys } = pasteInto({ text: screenOf("pi--v110-question-answer-editor") });
    expect(screen.getByText("Pasted text has line breaks. Nothing sent yet.")).toBeInTheDocument();
    expect(offered()).toEqual(["Keep lines", "One line", "Discard"]);
    expect(keys).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Keep lines" }));
    await waitFor(() => expect(keys.filter((key) => key === "ctrl+j")).toHaveLength(2));
    expect(keys.join("")).toBe("firstSpacelinectrl+jsecondSpacelinectrl+jthird");
    expect(keys).not.toContain("Enter");
    expect(box).toHaveValue("third");

    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(keys.at(-1)).toBe("Enter"));
    expect(keys.filter((key) => key === "Enter")).toHaveLength(1);
  });

  it.each([
    ["pi's own editor, where the key can accept a completion", { text: screenOf("pi--v110-idle") }],
    ["pi's own editor with a draft in it", { text: screenOf("pi--v110-draft-multiline") }],
    ["an editor whose keys were not measured (OmO)", { text: screenOf("pi--omo-v5130-answer-editor") }],
    ["a pi screen that is no editor at all", { text: screenOf("pi--v110-core-selector") }],
    ["a harness that names no line-break key", { agent: "claude", text: screenOf("pi--v110-question-answer-editor") }],
  ])("does not offer it on %s, and Enter still waits", async (_what, over) => {
    const { box, keys } = pasteInto(over);
    expect(offered()).toEqual(["One line", "Discard"]);
    fireEvent.keyDown(box, { key: "Enter" });
    await Promise.resolve();
    expect(keys).toEqual([]);
    expect(box).toHaveValue(PASTE);
  });

  it("a shell gets line by line and no line-break key", () => {
    pasteInto({ agent: undefined, isShell: true });
    expect(offered()).toEqual(["One line", "Line by line", "Discard"]);
  });
});
