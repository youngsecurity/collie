// ── ONE MASK PER ANSWER, WHICHEVER BRIDGE MADE THE ANSWER ───────────────────────────────────────
// The answers that carry text a pane or an agent wrote, each with the mask `bridge/redact.ts` puts on
// it before a phone reads it: the mirror, a History page, a Chat body, a Changes diff, a Files body,
// and a pane's program-set title in the snapshot. Two callers use them and must agree to the byte:
// this bridge's own routes (server.ts), when the answer is made here, and a crew lead re-masking what
// a member sent (`bridge/crew/mask.ts`), because a member one release behind sent it unmasked. One
// function per answer, so the two cannot drift: a field masked here is masked on both paths.
//
// Every mask is the same width as what it hides, and the mask character matches no pattern, so
// running one of these over its own output changes nothing. That is what lets a lead mask a member's
// answer whatever the member's version: a 1.18 member's answer comes back byte for byte.
//
// Pure: no disk, no clock, no config. The `COLLIE_REDACT` switch is the caller's.

import type { ChangeCommitDiff, ChangeDiff, DurableConversationRow, FileReadAnswer, FilesListing, PaneReadResponse, PaneWire } from "./types.ts";
import { redactEntry } from "./journal/text.ts";
import type { TranscriptEntry } from "./journal/types.ts";
import { maskAsk } from "./durable/parse.ts";
import { redactAnsi, redactText } from "./redact.ts";

export { maskAsk } from "./durable/parse.ts";

/** Send/Ask replies carry display details and surfaces beside opaque control identifiers. */
export const maskControlReply = maskAsk;

/**
 * A mirror read with its text masked. The grid keeps its escapes and its columns (`redactAnsi`), and
 * the unwrapped rows a split URL needs are masked as plain text. Key order is the body's own, so the
 * ETag hashed over it is stable.
 */
export function maskPaneRead<T extends PaneReadResponse>(body: T): T {
  const masked = { ...body, text: redactAnsi(body.text) };
  if (body.logicalText !== undefined) masked.logicalText = redactText(body.logicalText);
  return masked;
}

/** A History page with every turn masked (`redactEntry`). Cursor, counts and flags are untouched. */
export function maskHistoryPage<T extends { entries: TranscriptEntry[] }>(page: T): T {
  return { ...page, entries: page.entries.map(redactEntry) };
}

/** Program-authored labels only; conversation/pane ids and paging cursors remain opaque. */
export function maskDurableConversations<T extends { items: DurableConversationRow[] }>(body: T): T {
  return {
    ...body,
    items: body.items.map((row) => {
      const masked = { ...row, title: redactText(row.title) };
      if (row.subtitle !== undefined) masked.subtitle = redactText(row.subtitle);
      return masked;
    }),
  };
}

/** A Chat body masked: the turns and, on a live window, the queued messages. */
export { redactChatBody as maskChatBody } from "./journal/live.ts";

/**
 * A Changes diff with its text masked, when the mask is on. A diff is file content, and file content
 * is where a key sits: a `.env` an agent edited, a config with a token in it. The mask keeps every
 * line and every column, so the hunk headers still count what the view draws.
 */
export function maskDiff<TDiff extends ChangeDiff | ChangeCommitDiff>(answer: TDiff, redact: boolean): TDiff {
  if (!redact || !answer.available) return answer;
  return { ...answer, diff: redactText(answer.diff) };
}

/** A Files view answer with a file's text masked, as {@link maskDiff} masks a diff. A listing is names only. */
export function maskFileBody<TAnswer extends FilesListing | FileReadAnswer>(answer: TAnswer, redact: boolean): TAnswer {
  if (!redact || !answer.available || !("text" in answer)) return answer;
  return { ...answer, text: redactText(answer.text) };
}

/**
 * A pane with the title a program in it set masked. Any program can write that title, so it can
 * hold a path, a command or a key; the operator's own label is not touched.
 */
export function maskTerminalTitle<P extends { terminalTitle?: string }>(pane: P): P {
  return pane.terminalTitle === undefined ? pane : { ...pane, terminalTitle: redactText(pane.terminalTitle) };
}

/** A stale answer may carry the current ask. Other outcomes keep their original shape. */
export function maskAskAnswer<T extends object>(body: T): T {
  return "ask" in body && body.ask !== undefined ? { ...body, ask: maskAsk(body.ask) } : body;
}

type PaneDisplay = Pick<PaneWire, "terminalTitle" | "asks" | "surface" | "hold" | "held" | "actions">;

function maskPaneDisplay<P extends PaneDisplay>(pane: P): P {
  let masked = maskTerminalTitle(pane);
  if (pane.asks !== undefined) masked = { ...masked, asks: pane.asks.map(maskAsk) };
  // These arrive from a peer as well as the local runtime. Mask at the final snapshot boundary,
  // not only while assembling local panes, so a peer's redaction opt-out cannot leak through a lead.
  if (pane.surface !== undefined) masked = { ...masked, surface: maskAsk(pane.surface) };
  if (pane.hold !== undefined) masked = { ...masked, hold: maskAsk(pane.hold) };
  if (pane.held !== undefined) masked = { ...masked, held: pane.held.map(maskAsk) };
  if (pane.actions !== undefined) masked = { ...masked, actions: pane.actions.map(maskAsk) };
  return masked;
}

/**
 * A pane's todo list with its words masked. A task's subject and its present-tense form are text an
 * agent wrote, so they can hold a path, a command or a key. Ids and statuses are the bridge's own.
 */
export function maskTodoList<T extends { text: string; activeForm?: string }>(todos: readonly T[]): T[] {
  return todos.map((todo) => {
    const masked = { ...todo, text: redactText(todo.text) };
    if (todo.activeForm !== undefined) masked.activeForm = redactText(todo.activeForm);
    return masked;
  });
}

/**
 * A pane's running subagents with their descriptions masked. The description is the text the agent
 * wrote when it started the subagent, so it can hold a path, a command or a key. The id, the type,
 * the model and the times are Claude Code's own.
 */
export function maskSubagentList<T extends { description: string }>(subagents: readonly T[]): T[] {
  return subagents.map((subagent) => ({ ...subagent, description: redactText(subagent.description) }));
}

/** The pane fields an agent or a program wrote, which the mask reaches. */
interface PaneWords {
  terminalTitle?: string;
  todos?: readonly { text: string; activeForm?: string }[];
  subagents?: readonly { description: string }[];
}

/**
 * A pane with its program-set title, its open asks, Surface, hold and actions (the fork's
 * `maskPaneDisplay`), its todo list and its subagents masked, whichever it carries.
 */
function maskPaneWords<P extends PaneWords & PaneDisplay>(pane: P): P {
  const titled = maskPaneDisplay(pane);
  const listed = titled.todos === undefined ? titled : { ...titled, todos: maskTodoList(titled.todos) };
  return listed.subagents === undefined ? listed : { ...listed, subagents: maskSubagentList(listed.subagents) };
}

/**
 * A snapshot with every pane's program-set title, open asks, todo list and subagents masked. The
 * lead's merged snapshot carries its members' panes as the members sent them, so a member that does
 * not mask sent them in clear.
 */
export function maskSnapshotTitles<
  S extends {
    agents: readonly (PaneWords & PaneDisplay)[];
    shellPanes: readonly PaneDisplay[];
  },
>(snapshot: S): S {
  return { ...snapshot, agents: snapshot.agents.map(maskPaneWords), shellPanes: snapshot.shellPanes.map(maskPaneDisplay) };
}

/**
 * A Sent answer (ADR 0107) with every line masked. A line that matched a pattern when it was sent was
 * never kept, so this changes a line only when the pattern list grew after it was recorded, or when a
 * member one release behind kept what this bridge would not. Every other field is untouched.
 */
export function maskSentAnswer<T extends { entries: readonly { line: string }[] }>(answer: T): T {
  return { ...answer, entries: answer.entries.map((entry) => ({ ...entry, line: redactText(entry.line) })) };
}
