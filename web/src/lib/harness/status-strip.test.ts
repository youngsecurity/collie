// The status strip re-surfaces only the rows an adapter took off the mirror (types.ts,
// `extractStatusLines`). A row the adapter's own blocks still show, in the mirror or in a lifted
// card, must not also stand in the strip: that is the doubled status lines of the 2026-10-20 field
// report (pi, then muse). One check over every captured screen of every registered adapter, so an
// adapter added later is held to it too.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "../ansi";
import { splitLines } from "../blocks";
import { adapterFor, registeredAgents } from "./registry";

const PANES = join(import.meta.dirname, "../../fixtures/panes");
// Fixture prefixes that are not the adapter's agent string.
const PREFIX_AGENT = new Map([
  ["claude-lab", "claude"],
  ["oc", "opencode"],
]);

function agentOf(name: string): string | undefined {
  const prefix = name.split("--")[0]!;
  return PREFIX_AGENT.get(prefix) ?? (registeredAgents().includes(prefix) ? prefix : undefined);
}

const fixtures = readdirSync(PANES)
  .filter((name) => name.endsWith(".txt") && agentOf(name) !== undefined)
  .toSorted();

describe("the status strip never doubles a row the blocks still show", () => {
  it("covers every adapter that has captures", () => {
    const covered = new Set(fixtures.map(agentOf));
    for (const agent of ["agy", "claude", "codex", "grok", "muse", "omp", "opencode", "pi"]) expect(covered.has(agent), agent).toBe(true);
  });

  it.each(fixtures)("%s", (name) => {
    const adapter = adapterFor(agentOf(name))!;
    const lines = splitLines(parseAnsi(readFileSync(join(PANES, name), "utf8")));
    const shown = new Set(adapter.buildBlocks(lines).flatMap((block) => ("lines" in block ? block.lines : [])));
    expect(adapter.extractStatusLines(lines).filter((row) => shown.has(row))).toEqual([]);
  });
});
