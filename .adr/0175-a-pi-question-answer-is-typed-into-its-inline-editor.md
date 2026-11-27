# 0175: a pi question answer is typed into its inline editor

- **Status:** Accepted for this fork (2026-11-14; multi-line answers 2026-11-25). A live run on a
  phone is still owed, see *Not yet measured*.
- **Date:** 2026-11-14
- **Shipped in:** unreleased
- **Trail:** [issue 133](https://github.com/youngsecurity/collie/issues/133) (answering a pi
  question in your own words took Keys to reach the row and Type to enter the text, with nothing
  on the card saying so) · `web/src/lib/pi-answer.ts` · `web/src/lib/harness/pi/ask.ts`
  (`readAnswerEditor`, `customCoreOf`) · `web/src/lib/harness/pi/index.ts` ·
  `web/src/lib/prompt-action.ts` · `web/src/components/prompt-select-block.tsx` ·
  `web/src/lib/surface/profiles/pi.json` (`keys.navigation`, `keys.newline`) ·
  [`ASK_NOTES.md`](../web/src/lib/harness/pi/ASK_NOTES.md) ·
  `web/src/fixtures/panes/pi--v0871-question*.txt`, `pi--v110-question*.txt` ·
  [ADR 0098](./0098-pi-questions-are-read-by-shape-and-footer.md) ·
  [ADR 0113](./0113-an-askuserquestion-answer-is-typed-into-its-field.md) ·
  [ADR 0080](./0080-a-pointed-list-is-walked-verified-then-confirmed.md) ·
  [ADR 0053](./0053-an-unread-dialog-still-has-a-way-out.md)

## Context

ADR 0098 reads every pi-family question by shape and closes with "The phone never types into a
dialog". ADR 0113 then typed answers into one field, Claude Code's AskUserQuestion, and left every
other harness's free-text row `free-text` and untyped until its keys were measured.

On pi that left a question card with buttons for the listed choices and nothing for the last row,
`Type something.`. To answer in your own words you opened Keys, walked the arrows to the row,
pressed Enter, switched to Type, entered the text and submitted, with the card gone raw for the
second half because a pointer on that row and the open editor both declined. Nothing on the card
named that route.

The stock `question` and `questionnaire` extensions are the screens with captures of all three
states (pi 0.87.1 and 1.1.0): the list, the pointer on `Type something.`, and the inline editor
open, empty and holding text. Their source (`ASK_NOTES.md`) says Up and Down clamp over every row
with the free-text row last, Enter on that row opens the editor, Enter in the editor submits, and
Escape goes back to the list.

## Decision

1. **The free-text row of a stock pi question is a `custom-answer`, and Collie types into its
   inline editor.** This amends ADR 0098's last bullet and ADR 0113's first decision for this one
   shape only: every row numbered at column 0, no checkbox, a rule frame, the footer giving the
   walk (arrows move, Enter selects), the free-text row last, and an editor drawn as a label, an
   inset rule, the text rows, the same inset rule, under a footer that names Enter as submit. The
   reader still names no extension and matches no label text.
2. **The reader reports three states of one question.** List (`pointer: "above"`), on the row
   (`pointer: "on"`), editor open (`focused: true`, `text` = what the editor holds). All three
   share one `coreSignature`, cut at the free-text row with the pointer and the row's `✎` mark
   blanked, so the recipe can follow the question across them. `signature` stays the whole frame
   and every write is bound to it. With the editor open the card offers one option, the footer's
   way out.
3. **The recipe walks, opens, types, proves, then answers** (`submitPiAnswer`):
   - entry guard against the model the person tapped;
   - one `Down` per verified read until the pointer is on the row, capped at the option count
     plus two;
   - `Enter`, bound to the read that proved the pointer is on the row, then a wait for the editor;
   - for each line of the answer: the reply path with `submit: false`, bound to the read before
     it (the empty editor for the first line), then a wait until the editor reads exactly the lines
     typed so far; between two lines the profile's newline key, bound to the read that proved the
     line before, then a wait for the new empty row;
   - `Enter`, bound to the read that proved the whole answer. It is the only key that commits an
     answer.
   Any drift refuses and nothing is sent after it.
4. **Collie types only into an empty editor.** No key that clears pi's editor was measured, so an
   editor that already holds text is shown read-only and a send is refused. ADR 0113's "clear only
   what the person saw" has no counterpart here, and the card offers no "change this answer".
5. **Up to five lines, and five editor rows once wrapped.** The draft is split at its line breaks
   (CRLF and CR too), each line is sanitised on its own, blank lines at the ends are dropped and
   blank lines inside are kept. Each of these is refused before any key, with the draft kept in the
   phone's editor: more than `MAX_ANSWER_LINES` (5) lines, or more than five rows once each line is
   wrapped at the dialog's width less four columns (`rowsOf`), because pi-tui's Editor shows at
   least five rows before it scrolls and a scrolled editor no longer shows the whole answer; a last
   line ending in a backslash, because pi-tui's Editor turns `\` then Enter into a line break, so
   the answering Enter would not submit (a backslash ending an inner line is typed, since the
   newline key never reads it). A line wider than a row is typed and pi wraps it. The reader joins
   the wrapped rows with a newline, so every read-back is compared by `editorShows`: a row break
   is one of the answer's own line breaks, or a wrap pi-tui's `wordWrapLine` could have made (after
   a run of spaces, which the trimmed read drops, or inside a word or CJK run), and only where the
   next word did not fit beside the row above. Any other break, an extra row or a missing one fails
   the read-back, and no answering Enter is sent. The cost is that a space the phone typed and a
   line break typed at the terminal at that exact point read the same; the empty-editor rule and
   the bound writes are what stand against a second typist. (2026-11-25: this replaced "one line
   only", which refused every line break. 2026-11-27: this replaced "each line one editor row
   wide", which refused a 76-character sentence on a 73-column pane in the first phone run.)
6. **The keys come from profile data**: `keys.navigation.down` and `.confirm`, and `keys.newline`
   (`ctrl+j`, pi-tui's `tui.input.newLine` beside `shift+enter`) in `pi.json`, which is what ADR
   0113's addendum asks of a second harness.
7. **The way out stays live while pi's editor is open.** `submitPromptOption` refuses every tap on
   a focused field (issue 95) except this one: the only option offered then is Escape, which types
   no character, and the guard still refuses if the editor's text is no longer what the card
   showed.

## What stays raw or untyped

- OmO and Senpi (`Type your own answer...`): the plan is a digit and Enter in the editor means
  "save and next". The row keeps `free-text`; the pointed row and the editor stay raw.
- gentle-pi's `Other…` and pi's own unnumbered selectors.
- Every multi-select, its pointed free-text row and its editor.
- A stock question beside OmO's side panel: the reply path carries no `expected_columns`, so the
  typed text could not be bound. The list keeps `free-text` there; the on-row and editor states
  stay raw.
- `composerReady` and `piModalOnScreen` are unchanged. An ordinary reply still never goes into a
  question's editor.

## Consequences

- A stock pi question can be answered in your own words from its card, with no Keys and no Type.
- A refusal after the editor opened leaves pi's editor open, possibly holding part of the text.
  The card then shows that text read-only beside the way back; the phone's draft is kept.
- If a screen redraw swaps the card for another block kind for one read during a send, the card
  remounts and its draft is lost. Not seen in tests; accepted.
- This is a divergence from upstream, which keeps ADR 0098's rule. `harness/pi/ask.ts` will
  conflict on upstream adoptions until the change is upstreamed or dropped.
- A pi or extension release that redraws the editor falls back to the raw mirror with the Escape
  card, as before this ADR.

## Not yet measured

The reader is tested on the captures and the recipe against a scripted pane.

On 2026-11-25 the recipe also ran, in a throwaway test that is not in the tree, against the real
code of pi-coding-agent 1.6.1's `question` and `questionnaire` examples and pi-tui 1.6.1's Editor
(the examples are the same in 1.4.0): keys went in through pi-tui's own `StdinBuffer`, each frame
was painted on an `@xterm/headless` 5.5.0 grid and read back by Collie's reader. One line, two
lines, CRLF, an inner blank line, five lines (also on a 12-row terminal), a line as wide as the
recipe allows, Unicode, a one-question questionnaire and the first tab of a two-question one were
all submitted with the exact text in pi's tool result. A last line ending in `\` was found to open
a new line instead of submitting, which is why decision 5 refuses it.

Nothing here was run against a live pi through a real terminal and bridge. Before this ships in a
release, one run on a phone must confirm, and record with its versions:

- that the bridge's text path lands in pi's inline editor as plain text on tmux and on Herdr (a
  bracketed paste that pi folds into a marker would fail the read-back and refuse, not mis-send);
- that `ctrl+j` reaches pi's editor as a line break through the terminal in use (a terminal that
  sends it as something else fails the read-back and refuses);
- that Enter in the editor submits the typed answer on the pi version in use.

A clear key for a filled editor, OmO and gentle-pi each need their own measurement and are not
decided here.
