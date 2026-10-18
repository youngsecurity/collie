import { expect, test } from "bun:test";
import { maskControlReply, maskSnapshotTitles } from "./answer-mask.ts";
import type { PaneWire } from "./types.ts";

const secret = `sk-test-placeholder-${"0".repeat(40)}`;
const masked = `sk-t${"•".repeat(secret.length - 4)}`;

test("v1.22.5 snapshot control fields are masked on local and member panes", () => {
  const pane = {
    terminalTitle: secret,
    surface: { revision: 1, turn: "idle", composer: "empty", modal: { ask: {
      id: secret, hash: secret, kind: "permission", channel: "keys", options: [{ id: secret, label: secret }],
    } } },
    hold: { askId: secret, hash: secret, input: secret, tool: secret, options: [secret],
      state: "held", agent: false, adopted: true, since: 1 },
    held: [{ requestId: secret, text: secret, mode: "send", heldAt: 1, expiresAt: 2, state: "held" }],
    actions: [{ id: secret, label: secret }],
  } satisfies Pick<PaneWire, "terminalTitle" | "surface" | "hold" | "held" | "actions">;
  // Crew snapshots flatten the member's panes into these same lists, with a host address.
  const snap = { agents: [pane, { ...pane, host: "member" }], shellPanes: [pane] };
  const before = JSON.stringify(snap);
  const out = maskSnapshotTitles(snap);
  const wanted = {
    terminalTitle: masked,
    surface: { ...pane.surface, modal: { ask: { ...pane.surface.modal.ask, options: [{ id: secret, label: masked }] } } },
    hold: { ...pane.hold, input: masked, tool: masked, options: [masked] },
    held: [{ ...pane.held[0]!, text: masked }],
    actions: [{ id: secret, label: masked }],
  };
  expect(out).toEqual({ agents: [wanted, { ...wanted, host: "member" }], shellPanes: [wanted] });
  expect(JSON.stringify(snap)).toBe(before);
});

test("Send and Ask receipts mask prose but retain stale-check identities", () => {
  const answer = {
    id: secret, requestId: secret, paneId: secret, session: secret,
    askIds: [secret], acknowledged: secret, paneGeneration: secret,
    reason: secret, detail: secret, surface: { rowsHash: secret, textHash: secret, hash: secret },
    receipts: [{ requestId: secret, paneId: secret, reason: secret, outcome: "refused" }],
  };
  const before = JSON.stringify(answer);
  const out = maskControlReply(answer);
  expect(out).toEqual({ ...answer, reason: masked, detail: masked,
    receipts: [{ requestId: secret, paneId: secret, reason: masked, outcome: "refused" }],
  });
  expect(JSON.stringify(answer)).toBe(before);
  expect(maskControlReply(out)).toEqual(out);
});
