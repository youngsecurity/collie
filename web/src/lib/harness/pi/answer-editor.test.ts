import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import { stockAnswerEditorOpen } from "./answer-editor";
import { piAdapter } from "./index";

const PANES = join(import.meta.dirname, "../../../fixtures/panes");
const load = (name: string) => splitLines(parseAnsi(readFileSync(join(PANES, name), "utf8")));
const pi = readdirSync(PANES).filter((name) => name.startsWith("pi--") && name.endsWith(".txt")).toSorted();

// The stock shape with its editor open: `question`, `questionnaire`, and the PR 397 single-select.
const STOCK_EDITORS = [
  "pi--v0871-question-answer-editor.txt",
  "pi--v0871-question-answer-editor-typed.txt",
  "pi--v0871-questionnaire-answer-editor.txt",
  "pi--v110-question-answer-editor.txt",
  "pi--v110-question-answer-editor-typed.txt",
  "pi--v110-questionnaire-answer-editor.txt",
  "pi--v110-single-editor-open.txt",
];

describe("pi: the stock question's inline answer editor (issue #134)", () => {
  it("is read on exactly the stock captures, and on no other pi screen", () => {
    expect(pi.filter((name) => stockAnswerEditorOpen(load(name)))).toEqual(STOCK_EDITORS.toSorted());
  });

  it.each([
    ["OmO's editor, where Enter saves and goes on", "pi--omo-v5130-answer-editor.txt"],
    ["a multi-select's editor", "pi--v110-multi-editor-open.txt"],
    ["a tab page's multi-select editor", "pi--v110-tabs-editor-open.txt"],
    ["a pointer on the free-text row, editor not open", "pi--v0871-question-other-focused.txt"],
    ["pi's own picker with its search row", "pi--v110-core-selector.txt"],
  ])("is not %s", (_what, name) => {
    expect(stockAnswerEditorOpen(load(name))).toBe(false);
    expect(piAdapter.lineBreakKeys?.(load(name))).toBeNull();
  });
});

describe("pi: where a line break can be typed without submitting (issue #134)", () => {
  it.each(STOCK_EDITORS)("names the profile's newline key on %s", (name) => {
    expect(piAdapter.lineBreakKeys?.(load(name))).toEqual(["ctrl+j"]);
  });

  // pi's own editor completes `/` commands and `@` files, and its open list takes the same key as
  // "accept": a kept line would be rewritten, or lose its break. So the editor being ready is not enough.
  it.each(["pi--v110-idle.txt", "pi--v110-draft-multiline.txt", "pi--v110-working.txt", "pi--omo-v5130-idle.txt"])(
    "does not name it on pi's own editor, where the key can accept a completion (%s)",
    (name) => {
      expect(piAdapter.composerReady?.(load(name))).toBe(true);
      expect(piAdapter.lineBreakKeys?.(load(name))).toBeNull();
    },
  );

  it("names it nowhere else: not on pi's own editor, not on any other modal", () => {
    for (const name of pi) {
      const known = STOCK_EDITORS.includes(name);
      expect(piAdapter.lineBreakKeys?.(load(name)) ?? null, name).toEqual(known ? ["ctrl+j"] : null);
    }
  });
});
