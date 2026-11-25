// The stock question's inline answer editor (issue #134): is it the thing on screen?
//
// Type mode is the way into this editor, and it submits on Enter. It is pi-tui's multi-line `Editor`,
// the same component as pi's own input: the `question` and `questionnaire` examples that ship with pi
// both build one and hand it every key but Escape. Measured against pi-tui 1.4.0's Editor on
// 2026-11-25, bytes in, text and submissions out:
//
//   Enter between two lines     submits the first line, leaves the second in the editor (the bug)
//   a raw line feed (`ctrl+j`)  adds a line, submits nothing; a blank line is kept
//   three lines, then Enter     submits all three once, as one answer
//   Backspace after a break     joins the two lines again
//   Tab                         is dropped: the editor has no completion to run
//
// So here the profile's newline key is a line break and not a submit, which is NOT true of every pi
// screen: pi-tui's one-row `Input` submits on a raw line feed. Hence a reader for this one shape.
//
// Read by shape, never by the label's words (.adr/0098): a rule-bounded frame whose footer gives Enter
// to submit and names Escape, no key that moves or picks, and above the footer an inset rule, the
// editor's rows, the same inset rule, one to three label rows, and the pointed, numbered free-text row
// with its `✎` mark. That is the stock `question`, the stock `questionnaire` and the PR 397
// single-select, which draws the same shape. OmO's editor (`Enter` saves and goes on), gentle-pi's
// `Other…` and every multi-select are other shapes, were not measured, and answer false.
//
// NOT measured through a real terminal: that Herdr delivers `ctrl+j` as a line feed to the pi version
// in use is owed to a phone rehearsal (ASK_NOTES.md).
import type { StyledLine } from "../../blocks";
import { readPiFrame } from "./ask";

/** A rule one column in: the answer editor's own top and bottom rule. */
const EDITOR_RULE = /^ ─{8,}$/;
/** A label row, one column in (`Your answer:`, wrapped on a narrow pane). */
const LABEL_ROW = /^ \S/;
const MAX_LABEL_ROWS = 3;
/** The free-text row while its editor is open: the pointer at column 0, a number, the mark. */
const EDITING_ROW = /^> \d+\. \S.* ✎$/;

export function stockAnswerEditorOpen(lines: StyledLine[]): boolean {
  const frame = readPiFrame(lines);
  if (frame === null || frame.open || frame.frameless) return false;
  const { footer, texts, top } = frame;
  if (footer.enter !== "submit" || footer.escapeVerb === null) return false;
  if (footer.arrowsMove || footer.digitsSelect || footer.spaceToggles) return false;

  let row = frame.footerStart - 1;
  while (row > top && texts[row] === "") row--;
  const rule = texts[row]!;
  if (row <= top || !EDITOR_RULE.test(rule)) return false;
  let held = 0;
  for (row--; row > top && texts[row] !== rule; row--) {
    if (texts[row] !== "" && !texts[row]!.startsWith(" ")) return false;
    held++;
  }
  if (row <= top || held === 0) return false;
  let labels = 0;
  for (row--; row > top && LABEL_ROW.test(texts[row]!) && !EDITOR_RULE.test(texts[row]!); row--) labels++;
  if (labels < 1 || labels > MAX_LABEL_ROWS) return false;
  while (row > top && texts[row] === "") row--;
  return row > top && EDITING_ROW.test(texts[row]!);
}
