// The one recipe that answers a stock pi question in the person's own words (.adr/0175). The reader
// (harness/pi/ask.ts) reports the question's `custom-answer` row in three states, and this walks them:
//
//   1. LIST, the pointer on a choice. One `Down` per verified read, bound to that read, until a read
//      shows the pointer on the free-text row. The list clamps, so a spare arrow moves nothing.
//   2. ON THE ROW. `Enter`, bound to the read that proved the pointer is there: on any other row the
//      same key answers the question, so the bridge must still find that exact screen.
//   3. EDITOR OPEN. It must be EMPTY: text in it is somebody typing at the terminal, and pi's editor
//      has no measured clear key. Type the first line through the reply path, bound to the read that
//      showed it empty, and wait until the editor reads exactly that. Each further line is the pi
//      profile's `keys.newline` (the composer's own key: the question's editor is the same pi-tui
//      Editor), bound to the read that proved the lines so far, a wait for the new empty row, then the
//      line, typed and proved the same way.
//   4. `Enter`, the only key that answers, bound to the read that proved the whole text.
//
// Every step refuses on drift and sends nothing after the refusal. The keys are the pi profile's
// `keys.navigation` and `keys.newline` (.adr/0113's addendum: a second harness's keys live in profile
// data). Every line must fit one row of the editor, since a wrapped line reads back as two rows, which
// never equal it; and there are at most MAX_ANSWER_LINES of them, so the editor never scrolls a line
// out of the read (harness/pi/ASK_NOTES.md).

import { ANSWER_MAX_LENGTH } from "./answer-field";
import { sendReply } from "./api";
import { describeApiError, describeThrownError } from "./api-error-message";
import { dialogDetector, guardDialog, sendBoundKeys, type DialogTarget } from "./dialog-guard";
import { DIALOG_CONTRACT } from "./harness/dialog-contract";
import { pollUntil, sanitizeTypedText, type ActionResult, type PollOutcome, type Sleep } from "./harness/guard";
import type { PromptModel } from "./harness/prompt-model";
import { t } from "./i18n";
import { requireProfile } from "./surface/profile";
import { displayWidth } from "./text-width";

/** Arrows sent past the question's own rows before the walk gives up: the list clamps, so these
 *  cover a swallowed key, not a longer list. */
const SPARE_ARROWS = 2;

/** Columns of the dialog's width the editor's one row does not give to text: its inset on both
 *  sides and the caret's cell, with one to spare (pi--v110-question-answer-editor-typed.txt). A
 *  guess on the safe side; the read-back in step 3 is what the answering key stands on. */
const EDITOR_MARGIN = 4;

/** Lines an answer may hold: pi's editor shows at least five rows before it scrolls (pi-tui's
 *  Editor keeps `max(5, 30% of the terminal)`), and a scrolled editor hides what the read must prove. */
export const MAX_ANSWER_LINES = 5;

type Target = DialogTarget<"prompt-select"> & { sleep?: Sleep };

const refuse = (why: string): ActionResult => ({ status: "changed", why });
const fail = (error: string): ActionResult => ({ status: "error", error });

/** A refused write keeps the bridge's own reason; anything else passes through. */
const withWhy = (result: ActionResult, why: string): ActionResult =>
  result.status === "changed" ? { status: "changed", why: result.why ?? why } : result;

/**
 * Whether `a` and `b` are the same custom-answer question, in whichever of its three states. The
 * contract's identity cannot say so: the open editor offers no choices, so its options differ from
 * the list's. `coreSignature` holds the header, the question and every row down to the free-text one.
 */
export function samePiQuestion(a: PromptModel, b: PromptModel): boolean {
  return (
    a.feedback?.purpose === "custom-answer" &&
    b.feedback?.purpose === "custom-answer" &&
    a.question === b.question &&
    a.caption === b.caption &&
    a.coreSignature === b.coreSignature
  );
}

/** The answer's lines, each cleaned like every typed field. Inner blank lines stay: pi keeps them. */
function answerLines(text: string): string[] {
  return text
    .trim()
    .split(/\r\n|\r|\n/)
    .map((line) => sanitizeTypedText(line, ANSWER_MAX_LENGTH));
}

/** The text columns one editor row holds, from the dialog's top rule (the first row of its region). */
function editorRoom(m: PromptModel): number {
  return displayWidth(m.signature.split("\n", 1)[0]!) - EDITOR_MARGIN;
}

function sendBoundTo(target: Target, keys: string[], m: PromptModel): Promise<ActionResult> {
  const contract = DIALOG_CONTRACT["prompt-select"];
  return sendBoundKeys(target, keys, contract.region(m), contract.styled?.(m), contract.columns?.(m), contract.tail?.(m));
}

function poll(target: Target, accept: (m: PromptModel) => boolean): Promise<PollOutcome<PromptModel>> {
  return pollUntil(
    target,
    target.model,
    dialogDetector("prompt-select", target.agent),
    (m) => samePiQuestion(m, target.model) && accept(m),
    samePiQuestion,
  );
}

/**
 * Answer the pi question of `target.model` with `text`, up to MAX_ANSWER_LINES lines. `sent` means
 * the answering `Enter` went out. Refuses (`changed`, with the step in `why`) when the question moved under it; errors,
 * with what to do, when the text cannot be typed or an awaited state never came. After a refusal or
 * an error nothing more is sent, so the editor may be left open, holding what was typed.
 */
export async function submitPiAnswer(target: Target, text: string): Promise<ActionResult> {
  const seen = target.model.feedback;
  if (seen?.purpose !== "custom-answer") return refuse("entry");
  const lines = answerLines(text);
  if (lines.join("").length === 0) return fail(t("promptAction.feedback.empty"));
  if (lines.length > MAX_ANSWER_LINES) {
    return fail(t("promptAction.customAnswer.tooManyLines", { count: MAX_ANSWER_LINES }));
  }
  const room = editorRoom(target.model);
  if (lines.some((line) => displayWidth(line) > room)) return fail(t("promptAction.customAnswer.tooLong"));
  // pi's Editor turns `Enter` after a backslash into a line break (its stand-in for Shift+Enter), so
  // the answering key would leave the question open. Measured on pi-tui 1.6.1.
  if (lines[lines.length - 1]?.endsWith("\\")) return fail(t("promptAction.customAnswer.trailingBackslash"));
  if (seen.text !== "") return fail(t("promptAction.customAnswer.editorBusy"));
  const { navigation, newline } = requireProfile("pi").keys;
  const { down, confirm } = navigation;
  try {
    const guarded = await guardDialog(target);
    if (!guarded.ok) return withWhy(guarded.result, "entry");
    // The guard compared the fresh read with the tapped model as a commit does, region included, so
    // the tapped model stands for that read.
    let current = target.model;

    // Steps 1 and 2: to the row, then into its editor.
    const arrows = current.options.length + SPARE_ARROWS;
    for (let walked = 0; current.feedback?.focused !== true; ) {
      const onRow = current.feedback?.pointer === "on";
      if (!onRow && walked === arrows) return fail(t("promptAction.answer.fieldNotReached"));
      const sent = await sendBoundTo(target, [onRow ? confirm : down], current);
      if (sent.status !== "sent") return withWhy(sent, "bridge");
      if (!onRow) walked++;
      const before = current.signature;
      const moved = await poll(target, (m) => (onRow ? m.feedback?.focused === true : m.signature !== before));
      if (moved.status === "drifted") return refuse(onRow ? "open: drift" : "walk: drift");
      if (moved.status === "timeout") {
        return fail(t(onRow ? "promptAction.customAnswer.notOpened" : "promptAction.answer.fieldNotReached"));
      }
      current = moved.model;
    }

    // Step 3: only into an empty editor, and only while the bridge still finds it empty. Each write is
    // bound to the read that proved everything before it.
    if (current.feedback?.text !== "") return fail(t("promptAction.customAnswer.editorBusy"));
    for (const [i, line] of lines.entries()) {
      if (i > 0) {
        const broke = await sendBoundTo(target, [...newline], current);
        if (broke.status !== "sent") return withWhy(broke, "bridge");
        const opened = `${lines.slice(0, i).join("\n")}\n`;
        const fresh = await poll(target, (m) => m.feedback?.focused === true && m.feedback.text === opened);
        if (fresh.status === "drifted") return refuse("break: drift");
        if (fresh.status === "timeout") return fail(t("promptAction.answer.notArrived"));
        current = fresh.model;
      }
      if (line === "") continue;
      const typed = await sendReply(target.paneId, line, false, target.scope, current.signature);
      if (!typed.ok) {
        return typed.code === "prompt_changed" ? refuse("type: bridge") : fail(describeApiError(typed));
      }
      const held = lines.slice(0, i + 1).join("\n");
      const landed = await poll(target, (m) => m.feedback?.focused === true && m.feedback.text === held);
      if (landed.status === "drifted") return refuse("type: drift");
      if (landed.status === "timeout") return fail(t("promptAction.answer.notArrived"));
      current = landed.model;
    }

    // Step 4: the answering key, bound to the read that proved the whole text.
    return withWhy(await sendBoundTo(target, [confirm], current), "bridge");
  } catch (e) {
    return fail(describeThrownError(e));
  }
}
