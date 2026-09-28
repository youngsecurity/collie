import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_EXPECTED_PROMPT_CHARS, verifyExpectedPrompt } from "../../../../../bridge/prompt-binding";
import { parseAnsi } from "../../ansi";
import { lineText, splitLines } from "../../blocks";
import { codexAdapter } from "./index";
import { promptsEqual } from "../prompt-model";
import { detectApprovalRegion } from "./approval";
import { detectTrustRegion } from "./trust";

// Mutate captures in memory only. Both the phone comparison and the bridge's final write binding
// must reject a successor with the same question and options but a different approval subject.
for (const [name, detect, before, after, keys] of [
  ["approval-patch", detectApprovalRegion, '"hello"', '"wrong"', ["y"]],
  ["trust", detectTrustRegion, "/tmp/collie-codex-debug", "/tmp/untrusted-folder", ["Enter"]],
] as const) {
  describe(`Codex ${name} subject binding`, () => {
    const raw = readFileSync(join(import.meta.dirname, "../../../fixtures/panes", `codex--v0156-${name}.txt`), "utf8");
    const changed = raw.replace(before, after);
    const model = () => detect(splitLines(parseAnsi(raw)))!.model;

    it("keeps unchanged-subject approval and its printed keys", () => {
      expect(model().options[0]!.keys).toEqual(keys);
      expect(promptsEqual(model(), model())).toBe(true);
      expect(verifyExpectedPrompt(raw, model().signature)).toEqual({ ok: true });
    });

    it("excludes unrelated history without losing any displayed subject rows", () => {
      const prefix = "Unrelated previous transcript output.\n".repeat(300);
      const prefixed = detect(splitLines(parseAnsi(prefix + raw)))!.model;
      expect(promptsEqual(model(), prefixed)).toBe(true);
      expect(prefixed.signature).not.toContain("Unrelated");
      expect(prefixed.signature).toContain(before);
    });

    it("keeps the complete subject at the API limit and stays raw one character over", () => {
      const padding = "x".repeat(MAX_EXPECTED_PROMPT_CHARS - model().signature.length);
      const atLimit = raw.replace(before, before + padding);
      const atLimitModel = detect(splitLines(parseAnsi(atLimit)))!.model;
      expect(atLimitModel.signature.length).toBe(MAX_EXPECTED_PROMPT_CHARS);
      expect(verifyExpectedPrompt(atLimit, atLimitModel.signature)).toEqual({ ok: true });
      const tooLarge = atLimit.replace(before, before + "x");
      const lines = splitLines(parseAnsi(tooLarge));
      expect(detect(lines)).toBeNull();
      const blocks = codexAdapter.buildBlocks(lines);
      expect(blocks.every((b) => b.kind === "raw")).toBe(true);
      expect(blocks.flatMap((b) => b.lines).map(lineText).join("\n")).toContain(before + "x" + padding);
      expect(codexAdapter.composerReady!(lines)).toBe(false);
    });

    it("rejects the changed subject in the phone comparison", () => {
      expect(changed).not.toBe(raw);
      const replacement = detect(splitLines(parseAnsi(changed)))!.model;
      expect(replacement.options).toEqual(model().options);
      expect(promptsEqual(model(), replacement)).toBe(false);
    });

    it("rejects the changed subject at the bridge's final write guard", () => {
      expect(verifyExpectedPrompt(changed, model().signature)).toEqual({ ok: false, reason: "not_found" });
    });

    it("refuses a missing or unrecognised subject heading instead of binding only the question", () => {
      const text = splitLines(parseAnsi(raw)).map(lineText).join("\n");
      const heading = name === "trust" ? "Folder access" : "• Added hello.py (+1 -0)";
      expect(text).toContain(heading);
      const unknown = text.replace(heading, "Unknown subject");
      expect(detect(splitLines(parseAnsi(unknown)))).toBeNull();
      expect(detect(splitLines(parseAnsi(text + "\n" + unknown)))).toBeNull();
      if (name === "trust") {
        expect(detect(splitLines(parseAnsi(text.replace(before, ""))))).toBeNull();
      }
      const question = name === "trust" ? "  Trust this folder?" : "  Would you like to make";
      const clipped = text.slice(text.indexOf(question));
      expect(clipped).not.toBe(text);
      expect(detect(splitLines(parseAnsi(clipped)))).toBeNull();
    });

    it("binds every row of a multiline subject, not only its tail", () => {
      const text = splitLines(parseAnsi(raw)).map(lineText).join("\n");
      const expanded = name === "trust"
        ? text.replace(before, before + "\n  /wrapped-directory\n  /last-component")
        : text.replace('print("hello")', 'print("hello")\n' + '    2 +more patch content\n'.repeat(120));
      expect(expanded).not.toBe(text);
      const first = detect(splitLines(parseAnsi(expanded)))!.model;
      const successor = expanded.replace(before, after);
      const second = detect(splitLines(parseAnsi(successor)))!.model;
      expect(promptsEqual(first, second)).toBe(false);
      expect(verifyExpectedPrompt(expanded, first.signature)).toEqual({ ok: true });
      expect(verifyExpectedPrompt(successor, first.signature)).toEqual({ ok: false, reason: "not_found" });
      if (name === "trust") {
        expect(first.signature).toContain("/wrapped-directory\n  /last-component");
        expect(verifyExpectedPrompt(expanded.replace("/last-component", "/changed-component"), first.signature))
          .toEqual({ ok: false, reason: "not_found" });
      }
    });
  });
}
