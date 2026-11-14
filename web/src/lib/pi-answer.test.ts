import { beforeEach, describe, expect, it, vi } from "vitest";

// The pi custom-answer recipe (.adr/0126, harness/pi/ASK_NOTES.md): walk the pointer to the free-text
// row, open its inline editor, type into it only while it is empty, prove the text, then the one
// answering Enter. The api layer is mocked so every fresh screen is scripted; the adapter, the reader
// and the guard are the real thing. Each test pins one rule, and what was NOT sent.
vi.mock("./api", () => ({
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
  sendReply: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchPane, sendKeys, sendReply } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines, type PromptModel } from "./blocks";
import { dialogDetector } from "./dialog-guard";
import { POLL_ATTEMPTS } from "./harness/guard";
import { t } from "./i18n";
import { samePiQuestion, submitPiAnswer } from "./pi-answer";

const mockFetchPane = vi.mocked(fetchPane);
const mockSendKeys = vi.mocked(sendKeys);
const mockSendReply = vi.mocked(sendReply);

const PANES = join(import.meta.dirname, "..", "fixtures", "panes");
const capture = (name: string) => readFileSync(join(PANES, name), "utf8");

// The stock `question` of pi 1.1.0, rebuilt row for row around a real capture's scrollback and
// status rows, so the pointer can stand on any row and the editor can hold any text.
const LIST = capture("pi--v110-question-single.txt").split("\n");
const FULL_RULE = (l: string) => l.includes("─".repeat(120));
const BOTTOM = LIST.findLastIndex(FULL_RULE);
const TOP = LIST.slice(0, BOTTOM).findLastIndex(FULL_RULE);
const HEAD = LIST.slice(0, TOP);
const TAIL = LIST.slice(BOTTOM + 1);
const RULE = LIST[TOP]!;
const INSET = capture("pi--v110-question-answer-editor.txt")
  .split("\n")
  .find((l) => l.startsWith(" ") && l.includes("─".repeat(118)))!
  .trimEnd();

/** Paint a row as pi does: the indent plain, the words in one colour. The reader takes an unpainted
 *  footer for quoted text. */
function paint(row: string, colour: string): string {
  const indent = row.length - row.trimStart().length;
  return row.trim() === "" ? row : `${row.slice(0, indent)}\x1b[0m\x1b[38;2;${colour}m${row.slice(indent)}\x1b[0m`;
}
const TEXT = "222;224;225";
const DIM = "126;136;142";

interface Screen {
  /** The row `>` stands on: a choice (0-2) or the free-text row (3). */
  pointer?: 0 | 1 | 2 | 3;
  /** What the open editor holds; absent while it is closed. */
  editor?: string;
  question?: string;
}

function ask({ pointer = 0, editor, question = "Pick a color for the Collie probe?" }: Screen = {}): string {
  const mark = (i: number) => (i === pointer ? ">" : " ");
  const choices = [
    ["Red", "Warm and loud."],
    ["Green", "Calm and natural."],
    ["Blue", "Cool and deep."],
  ] as const;
  const frame = [
    paint(` ${question}`, TEXT),
    "",
    ...choices.flatMap(([label, description], i) => [
      paint(`${mark(i)} ${i + 1}. ${label}`, TEXT),
      paint(`     ${description}`, DIM),
    ]),
    paint(`${mark(3)} 4. Type something.${editor === undefined ? "" : " ✎"}`, TEXT),
    "",
    ...(editor === undefined
      ? [paint(" ↑↓ navigate • Enter to select • Esc to cancel", DIM)]
      : [
          paint(" Your answer:", DIM),
          INSET,
          ...editor.split("\n").map((row) => ` ${row}\x1b[0m\x1b[7m \x1b[0m`),
          INSET,
          "",
          paint(" Enter to submit • Esc to go back", DIM),
        ]),
  ];
  return [...HEAD, RULE, ...frame.map((row) => `${row}\r`), RULE, ...TAIL].join("\n");
}

const detect = dialogDetector("prompt-select", "pi");

function model(text: string): PromptModel {
  const m = detect(splitLines(parseAnsi(text)));
  if (!m) throw new Error("screen did not read as a question");
  return m;
}

const pane = (text: string) => ({ paneId: "w1:p1", text, truncated: false, revision: 5 });

function answer(tapped: string, text = "Navy") {
  return submitPiAnswer(
    {
      paneId: "w1:p1",
      requestedLines: 600,
      detectedRevision: 5,
      agent: "pi",
      kind: "prompt-select",
      model: model(tapped),
      sleep: async () => {},
    },
    text,
  );
}

/** Script the screens the reads return, in order; the last one repeats. */
function screens(...texts: string[]) {
  for (const text of texts.slice(0, -1)) mockFetchPane.mockResolvedValueOnce(pane(text));
  mockFetchPane.mockResolvedValue(pane(texts.at(-1)!));
}

/** Every key write, with the region it was bound to. */
const writes = () => mockSendKeys.mock.calls.map((c) => ({ keys: c[1], bound: c[3] }));
const keys = () => mockSendKeys.mock.calls.map((c) => c[1]);
const bound = (text: string) => model(text).signature;
const refusal = { ok: false as const, error: "prompt changed", code: "prompt_changed" };

const ON_ROW = ask({ pointer: 3 });
const EMPTY = ask({ pointer: 3, editor: "" });
const NAVY = ask({ pointer: 3, editor: "Navy" });

beforeEach(() => {
  mockFetchPane.mockReset();
  mockSendKeys.mockReset();
  mockSendReply.mockReset();
  mockSendKeys.mockResolvedValue({ ok: true });
  mockSendReply.mockResolvedValue({ ok: true });
});

describe("the rebuilt screen reads like the pi 1.1.0 captures", () => {
  it.each([
    ["pi--v110-question-single.txt", ask()],
    ["pi--v110-question-other-focused.txt", ON_ROW],
    ["pi--v110-question-answer-editor.txt", EMPTY],
    ["pi--v110-question-answer-editor-typed.txt", ask({ pointer: 3, editor: "teal" })],
  ])("%s", (name, rebuilt) => {
    const { signature: _a, coreSignature: _b, ...read } = model(rebuilt);
    const { signature: _c, coreSignature: _d, ...captured } = model(capture(name));
    expect(read).toEqual(captured);
  });

  it("is one question in every state, and another once its words change", () => {
    const list = model(ask());
    for (const state of [ask({ pointer: 2 }), ON_ROW, EMPTY, NAVY]) expect(samePiQuestion(model(state), list)).toBe(true);
    expect(samePiQuestion(model(ask({ question: "Pick a size for the Collie probe?" })), list)).toBe(false);
  });
});

describe("submitPiAnswer", () => {
  it("walks to the row, opens the editor, types, proves the text and answers, each write bound to its read", async () => {
    screens(ask(), ask({ pointer: 1 }), ask({ pointer: 2 }), ON_ROW, EMPTY, NAVY);
    expect(await answer(ask())).toEqual({ status: "sent" });
    expect(writes()).toEqual([
      { keys: ["Down"], bound: bound(ask()) },
      { keys: ["Down"], bound: bound(ask({ pointer: 1 })) },
      { keys: ["Down"], bound: bound(ask({ pointer: 2 })) },
      { keys: ["Enter"], bound: bound(ON_ROW) },
      { keys: ["Enter"], bound: bound(NAVY) },
    ]);
    expect(mockSendReply.mock.calls).toEqual([["w1:p1", "Navy", false, undefined, bound(EMPTY)]]);
  });

  it("sends no arrow when the pointer is already on the row", async () => {
    screens(ON_ROW, EMPTY, NAVY);
    expect(await answer(ON_ROW)).toEqual({ status: "sent" });
    expect(keys()).toEqual([["Enter"], ["Enter"]]);
  });

  it("types straight into an editor that is already open and empty", async () => {
    screens(EMPTY, NAVY);
    expect(await answer(EMPTY)).toEqual({ status: "sent" });
    expect(keys()).toEqual([["Enter"]]);
    expect(writes()[0]!.bound).toBe(bound(NAVY));
    expect(mockSendReply).toHaveBeenCalledTimes(1);
  });

  it("collapses inner whitespace and trims, like every typed field", async () => {
    screens(EMPTY, ask({ pointer: 3, editor: "Navy blue" }));
    expect(await answer(EMPTY, "  Navy   blue ")).toEqual({ status: "sent" });
    expect(mockSendReply.mock.calls[0]![1]).toBe("Navy blue");
  });

  it("refuses when the screen moved between the tap and the send", async () => {
    screens(ask({ pointer: 1 }));
    expect(await answer(ask())).toEqual({ status: "changed", why: "entry" });
    expect(mockSendKeys).not.toHaveBeenCalled();
    expect(mockSendReply).not.toHaveBeenCalled();
  });

  it("stops the walk when another question takes the screen: no Enter, no text", async () => {
    screens(ask(), ask({ pointer: 1 }), ask({ pointer: 2, question: "Pick a size for the Collie probe?" }));
    expect(await answer(ask())).toEqual({ status: "changed", why: "walk: drift" });
    expect(keys()).toEqual([["Down"], ["Down"]]);
    expect(mockSendReply).not.toHaveBeenCalled();
  });

  it("types nothing when the question is cancelled as the editor opens", async () => {
    screens(ON_ROW, "pi is working\n");
    expect(await answer(ON_ROW)).toEqual({ status: "changed", why: "open: drift" });
    expect(keys()).toEqual([["Enter"]]);
    expect(mockSendReply).not.toHaveBeenCalled();
  });

  it("takes the bridge's refusal of the text as a changed question, and sends no Enter after it", async () => {
    screens(ON_ROW, EMPTY);
    mockSendReply.mockResolvedValue(refusal);
    expect(await answer(ON_ROW)).toEqual({ status: "changed", why: "type: bridge" });
    expect(keys()).toEqual([["Enter"]]);
  });

  it("does not answer when the question goes away after the text was typed", async () => {
    screens(EMPTY, "pi is working\n");
    expect(await answer(EMPTY)).toEqual({ status: "changed", why: "type: drift" });
    expect(mockSendReply).toHaveBeenCalledTimes(1);
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("types nothing into an editor that already holds text", async () => {
    screens(ON_ROW, ask({ pointer: 3, editor: "from the desk" }));
    expect(await answer(ON_ROW)).toEqual({ status: "error", error: t("promptAction.customAnswer.editorBusy") });
    expect(keys()).toEqual([["Enter"]]);
    expect(mockSendReply).not.toHaveBeenCalled();
  });

  it("refuses a tapped editor that holds text before reading anything", async () => {
    expect(await answer(NAVY, "Teal")).toEqual({ status: "error", error: t("promptAction.customAnswer.editorBusy") });
    expect(mockFetchPane).not.toHaveBeenCalled();
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it.each([
    ["other text", "Navyy"],
    ["text someone typed ahead of it", "xNavy"],
    ["a wrapped answer", "Na\nvy"],
  ])("sends no answering Enter when the editor reads back %s", async (_what, held) => {
    screens(EMPTY, ask({ pointer: 3, editor: held }));
    expect(await answer(EMPTY)).toEqual({ status: "error", error: t("promptAction.answer.notArrived") });
    expect(mockSendReply).toHaveBeenCalledTimes(1);
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("refuses an answer of several lines before any read or key", async () => {
    expect(await answer(ask(), "first line\nsecond line")).toEqual({
      status: "error",
      error: t("promptAction.customAnswer.multiline"),
    });
    expect(mockFetchPane).not.toHaveBeenCalled();
    expect(mockSendKeys).not.toHaveBeenCalled();
    expect(mockSendReply).not.toHaveBeenCalled();
  });

  it("refuses an answer wider than one editor row before any key, wide characters counted double", async () => {
    const tooLong = { status: "error", error: t("promptAction.customAnswer.tooLong") };
    expect(await answer(ask(), "a".repeat(117))).toEqual(tooLong);
    expect(await answer(ask(), "色".repeat(59))).toEqual(tooLong);
    expect(mockFetchPane).not.toHaveBeenCalled();
    screens(EMPTY, ask({ pointer: 3, editor: "a".repeat(116) }));
    expect(await answer(EMPTY, "a".repeat(116))).toEqual({ status: "sent" });
  });

  it("refuses an empty answer", async () => {
    expect(await answer(ask(), "   ")).toEqual({ status: "error", error: t("promptAction.feedback.empty") });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("stops at a key the bridge refuses, and sends nothing after it", async () => {
    screens(ask());
    mockSendKeys.mockResolvedValue({ ...refusal, reason: "region_moved" });
    expect(await answer(ask())).toEqual({ status: "changed", why: "bridge: region_moved" });
    expect(keys()).toEqual([["Down"]]);
    expect(mockSendReply).not.toHaveBeenCalled();
  });

  it("gives up on a swallowed arrow without pressing Enter", async () => {
    screens(ask());
    expect(await answer(ask())).toEqual({ status: "error", error: t("promptAction.answer.fieldNotReached") });
    expect(keys()).toEqual([["Down"]]);
    expect(mockFetchPane).toHaveBeenCalledTimes(1 + POLL_ATTEMPTS);
    expect(mockSendReply).not.toHaveBeenCalled();
  });

  it("types nothing when the editor never opens", async () => {
    screens(ON_ROW);
    expect(await answer(ON_ROW)).toEqual({ status: "error", error: t("promptAction.customAnswer.notOpened") });
    expect(keys()).toEqual([["Enter"]]);
    expect(mockSendReply).not.toHaveBeenCalled();
  });

  it("refuses a model that carries no custom-answer row", async () => {
    const m = model(ask());
    const target = { paneId: "w1:p1", requestedLines: 600, detectedRevision: 5, agent: "pi", kind: "prompt-select" as const };
    const freeText = { ...m, feedback: { key: "", focused: false, text: "", purpose: "free-text" as const } };
    expect(await submitPiAnswer({ ...target, model: freeText }, "Navy")).toEqual({ status: "changed", why: "entry" });
    expect(mockFetchPane).not.toHaveBeenCalled();
  });
});
