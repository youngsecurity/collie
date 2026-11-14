import { describe, expect, it } from "vitest";

import { harnessOf } from "./signal";

describe("harnessOf: the report's own rule", () => {
  const row = { harness: "codex", version: "0.46.0" };

  it("takes the newest receipt first, then the context, then the dialog card's agent", () => {
    expect(harnessOf({ sends: [row, { harness: "claude", version: "2.1.316" }], context: { harness: "pi", harnessVersion: null } })).toEqual({ harness: "codex", version: "0.46.0" });
    expect(harnessOf({ sends: [], context: { harness: "pi", harnessVersion: null }, dialog: { agent: "omp" } })).toEqual({ harness: "pi", version: null });
    expect(harnessOf({ sends: [], context: null, dialog: { agent: "omp" } })).toEqual({ harness: "omp", version: null });
    expect(harnessOf({ sends: [], context: null })).toEqual({ harness: "no pane", version: null });
    expect(harnessOf({ sends: [{ harness: "", version: null }], context: null })).toEqual({ harness: "shell", version: null });
  });

  it("falls back to the bridge's cached version when no receipt names one (1.27.4)", () => {
    const context = { harness: "omp", harnessVersion: "18.16.0" };
    // No send on the pane: the context's agent and its cached version.
    expect(harnessOf({ sends: [], context, dialog: { agent: "omp" } })).toEqual({ harness: "omp", version: "18.16.0" });
    // A receipt without a version for the same agent takes the cached one.
    expect(harnessOf({ sends: [{ harness: "omp", version: null }], context })).toEqual({ harness: "omp", version: "18.16.0" });
    // A receipt's own version wins over the cache.
    expect(harnessOf({ sends: [{ harness: "omp", version: "18.17.0" }], context })).toEqual({ harness: "omp", version: "18.17.0" });
    // A receipt from another agent on the same pane never borrows this agent's version.
    expect(harnessOf({ sends: [{ harness: "codex", version: null }], context })).toEqual({ harness: "codex", version: null });
    // No context (a crew member's pane): receipts only, as before.
    expect(harnessOf({ sends: [], context: null, dialog: { agent: "omp" } })).toEqual({ harness: "omp", version: null });
    // A context with no cached version, and a bare shell.
    expect(harnessOf({ sends: [], context: { harness: "omp", harnessVersion: null } })).toEqual({ harness: "omp", version: null });
    expect(harnessOf({ sends: [], context: { harness: "", harnessVersion: null } })).toEqual({ harness: "shell", version: null });
  });
});
