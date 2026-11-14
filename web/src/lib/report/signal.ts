// The report's own facts: which agent program a report is about, its version, and which sends it
// lists. The report sheet titles its issue with {@link harnessOf} (lib/report/body.ts) over the two
// reads the sheet makes: the pane's send receipts and `GET /api/report/context`. With no receipt
// that names a version, the version is the context's `harnessVersion`, the bridge's own read of the
// binary. A harness is data here, never a branch. This file is pure.
//
// Upstream also builds its trouble signal here, the count its daily install ping carries. This fork
// has no ping, so nothing in this file leaves the phone unless the person files a report.

import type { SendReceiptRow } from "../surface/send";
import type { ReportContext } from "./context";

/** The report's word for a receipt's or a context's harness: `no pane` with none, `shell` for a plain one. */
export function harnessWord(harness: string | null | undefined): string {
  if (harness === null || harness === undefined) return "no pane";
  return harness === "" ? "shell" : harness;
}

/** Which agent a report is about, and its version. */
export interface HarnessFacts {
  readonly harness: string;
  readonly version: string | null;
}

/** What {@link harnessOf} reads: the sends newest first, the bridge's context, and the dialog card's agent. */
export interface HarnessSources {
  readonly sends: readonly Pick<SendReceiptRow, "harness" | "version">[];
  readonly context: Pick<ReportContext, "harness" | "harnessVersion"> | null;
  readonly dialog?: { readonly agent: string } | undefined;
}

/**
 * The newest receipt names the harness and its version; the context names the pane's agent when none
 * does, and the unread-dialog card's adapter when the context did not answer. When no receipt names a
 * version, the context's `harnessVersion` fills it, but only for the agent the context names: a
 * receipt from another agent on the same pane keeps its null.
 */
export function harnessOf(input: HarnessSources): HarnessFacts {
  const newest = input.sends[0];
  const known = input.context?.harnessVersion ?? null;
  if (newest !== undefined) {
    const harness = harnessWord(newest.harness);
    const sameAgent = input.context !== null && harnessWord(input.context.harness) === harness;
    return { harness, version: newest.version ?? (sameAgent ? known : null) };
  }
  if (input.context !== null && input.context.harness !== null) return { harness: harnessWord(input.context.harness), version: known };
  return { harness: harnessWord(input.context?.harness ?? input.dialog?.agent), version: null };
}

/** The sends a report lists: the streak's own when the card named them and they are still there, else all. */
export function reportedSends(rows: readonly SendReceiptRow[], requestIds: readonly string[] | undefined): SendReceiptRow[] {
  if (requestIds === undefined || requestIds.length === 0) return [...rows];
  const named = rows.filter((row) => requestIds.includes(row.requestId));
  return named.length > 0 ? named : [...rows];
}
