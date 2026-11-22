# 0175: a pi question answer is typed into its inline editor

- **Status:** Accepted for this fork (2026-11-14). A live run on a phone is still owed, see
  *Not yet measured*.
- **Date:** 2026-11-14
- **Shipped in:** unreleased
- **Trail:** [issue 133](https://github.com/youngsecurity/collie/issues/133) (answering a pi
  question in your own words took Keys to reach the row and Type to enter the text, with nothing
  on the card saying so) · `web/src/lib/pi-answer.ts` · `web/src/lib/harness/pi/ask.ts`
  (`readAnswerEditor`, `customCoreOf`) · `web/src/lib/harness/pi/index.ts` ·
  `web/src/lib/prompt-action.ts` · `web/src/components/prompt-select-block.tsx` ·
  `web/src/lib/surface/profiles/pi.json` (`keys.navigation`) ·
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
   - the reply path with `submit: false`, bound to the read of the empty editor, then a wait until
     the editor reads exactly the text;
   - `Enter`, bound to that read. It is the only key that commits an answer.
   Any drift refuses and nothing is sent after it.
4. **Collie types only into an empty editor.** No key that clears pi's editor was measured, so an
   editor that already holds text is shown read-only and a send is refused. ADR 0113's "clear only
   what the person saw" has no counterpart here, and the card offers no "change this answer".
5. **One line only.** A draft with a line break, or one wider than the dialog, is refused before
   any key, and the draft stays in the phone's editor. The reader joins wrapped editor rows with a
   newline, so a wrapped answer never equals the typed text and is never committed.
6. **The keys come from profile data**: `keys.navigation.down` and `.confirm` in `pi.json`, which
   is what ADR 0113's addendum asks of a second harness.
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

The reader is tested on the captures and the recipe against a scripted pane. Nothing here was run
against a live pi. Before this ships in a release, one run on a phone must confirm, and record
with its versions:

- that the bridge's text path lands in pi's inline editor as plain text (a bracketed paste that pi
  folds into a marker would fail the read-back and refuse, not mis-send);
- that Enter in the editor submits the typed text as the answer on the pi version in use (the
  reporter ran pi 1.4.0; the newest capture is 1.1.0);
- the `questionnaire` variant, whose tab strip the recipe reads but no capture shows with text
  typed.

Multi-line answers, a clear key for a filled editor, OmO and gentle-pi each need their own
measurement and are not decided here.
