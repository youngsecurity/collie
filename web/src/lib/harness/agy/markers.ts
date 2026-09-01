import { isBlank, lineText } from "../../blocks";
import { CLAUDE_RULE_GLYPH_CLASS } from "../../rule-glyphs";
import { displayWidth } from "../../text-width";
import type { PromptFamily } from "../prompt-model";

export { isBlank, lineText };

const RULE_ONLY = new RegExp(`^[${CLAUDE_RULE_GLYPH_CLASS}]+$`);

export function isHorizontalRule(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  return compact.length >= 3 && RULE_ONLY.test(compact);
}

const BARE_BORDER_MIN = 8;
const BARE_BORDER = /^[─━═-]+$/;
const LABELLED_BORDER = /^[─━═-]{2,}\s+(.+)\s+[─━═-]{2,}$/;
const RULE_OR_SPACE_ONLY = new RegExp(`^[${CLAUDE_RULE_GLYPH_CLASS}\\s]*$`);

export function isBoxBorder(text: string): boolean {
  const trimmed = text.trim();
  if (displayWidth(trimmed) < BARE_BORDER_MIN) return false;
  if (BARE_BORDER.test(trimmed)) return true;
  const m = LABELLED_BORDER.exec(trimmed);
  if (m === null) return false;
  return !RULE_OR_SPACE_ONLY.test(m[1]!);
}

const STEP_GLYPH = /[☐☒☑✔✅]/g;

export function isMultiStepHeader(text: string): boolean {
  const m = text.match(STEP_GLYPH);
  return m !== null && m.length >= 2;
}

export type { PromptFamily };

export function classifyFooter(text: string): PromptFamily | null {
  const t = text.toLowerCase();
  if (/\b(?:enter\s+confirm|enter\s+to\s+confirm)\b/.test(t)) return "trust";
  if (/\b(?:tab\s+amend|tab\s+to\s+amend)\b/.test(t)) return "permission";
  if (/\bctrl\+r\s+review\b/.test(t) && !/\btab\s+amend\b/.test(t)) return "plan";
  if (/ctrl\+g\s+to\s+edit\b/.test(t) || /\.antigravity\/plans\//.test(t) || /\.agy\/plans\//.test(t)) return "plan";
  if (/\b(?:enter\s+select|enter\s+to\s+select)\b/.test(t)) return "select";
  return null;
}

export function isAlienBuffer(texts: string[]): boolean {
  for (const text of texts) {
    if (/Claude Code|\.claude\/|Claude Sonnet|Claude Opus|Claude Max|AskUserQuestion/i.test(text)) {
      const full = texts.join(" ");
      if (!/Antigravity CLI|\.antigravity|agy/i.test(full)) return true;
    }
    if (/╭─ Ask ─╮/.test(text)) return true;
    // Bare product names are CONTENT, not chrome — an AGY question that merely mentions another
    // harness ("update the codex adapter?") must keep its buttons. Same guard as the Claude branch
    // above: stand down only when nothing else in the buffer says this is actually Antigravity.
    //
    // A footer-keyed (classifyFooter) exemption was tried and DISPROVEN by the conformance corpus:
    // codex--approval-exec.txt paints "Press enter to confirm", which is AGY's own trust-footer
    // grammar — dialog footers are shared TUI vocabulary, not unique chrome, and keying on them
    // un-fails-closed a real foreign capture. Until upstream gives AGY unique chrome, the marker
    // text is the best available evidence; a foreign buffer that also name-drops Antigravity slips
    // this net and is caught by harness attribution (herdr's agent name picks the adapter) and by
    // the foreign footer failing AGY's dialog grammar downstream.
    if (/\b(?:oh-my-pi|codex|grok)\b/i.test(text)) {
      const full = texts.join(" ");
      if (!/Antigravity CLI|\.antigravity|agy/i.test(full)) return true;
    }
  }
  return false;
}

