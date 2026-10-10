import { createContext, useContext, useMemo, type ReactNode, type Ref } from "react";

import type { AnsiSegment } from "@/lib/ansi";
import type { StyledLine } from "@/lib/blocks";
import type { TerminalColors } from "@/hooks/use-display-prefs";
import { isPlainClick, useFileLinks, type FileLinkOpener, type FileLinkTarget } from "@/components/file-links";
import {
  MIRROR_INVERT, MIRROR_SPACE, MUSE_MIRROR, mirrorColorStyle, segmentClassName, segmentStyle,
} from "@/components/mirror-space";
import { renderCells } from "@/components/painted-cells";
import { findFilePaths } from "@/lib/file-paths";
import { cn } from "@/lib/utils";

export interface RawMirrorAppearance {
  colors?: TerminalColors;
  nativeMirror?: boolean;
}

// A lifted card can replace the whole mirror. Its direct rows and PromptPanel's Terminal view
// must share the caller's appearance without teaching every dialog grammar about preferences.
export const RawMirrorAppearanceContext = createContext<RawMirrorAppearance>({});

// A path the agent printed is a link here too (ADR 0088), found per ROW on the row's plain text,
// after the ANSI parse. A path the terminal wrapped onto two rows is two pieces, and neither is
// joined to the other this round: each half is tried alone, and usually neither resolves. Only a
// path the bridge said exists is a link; the opener asks for the others and they stay text. The
// link keeps the agent's colours and adds only the mirror's own link mark, an underline in
// `currentColor`, the way an autolinked URL in the pane mirror reads (`ansi-output.tsx`), with the
// same free em-relative tap pad. A tap on the link opens the file; a tap anywhere else does what it
// did before, because the pane's tap-to-focus already lets a tap on an `a` through.
const MIRROR_LINK_CLASS = "underline decoration-1 underline-offset-2 cursor-pointer py-[0.35em]";

/** The styled spans of one row's slice `[from, to)`, keyed so siblings never collide. */
function styledSlice(segments: readonly AnsiSegment[], from: number, to: number, foreground?: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let at = 0;
  segments.forEach((s, si) => {
    const start = at;
    at += s.text.length;
    const a = Math.max(from, start);
    const b = Math.min(to, at);
    if (a >= b) return;
    nodes.push(
      <span key={`${si}:${a}`} style={segmentStyle(s, foreground)} className={segmentClassName(s)}>
        {renderCells(s.text.slice(a - start, b - start))}
      </span>,
    );
  });
  return nodes;
}

/** The paths in one row that the screen can open, in order, with where each leads. */
function rowLinks(text: string, open: FileLinkOpener): { start: number; end: number; target: FileLinkTarget }[] {
  const links: { start: number; end: number; target: FileLinkTarget }[] = [];
  for (const f of findFilePaths(text)) {
    const target = open(f);
    if (target !== null) links.push({ start: f.start, end: f.end, target });
  }
  return links;
}

/** One row: its styled spans, and any path in it wrapped in a link that keeps those spans. */
function MirrorRow({ line, open, foreground }: { line: StyledLine; open: FileLinkOpener | null; foreground?: string }) {
  const text = useMemo(() => line.segments.map((s) => s.text).join(""), [line]);
  const links = useMemo(() => (open === null ? [] : rowLinks(text, open)), [text, open]);
  if (links.length === 0) {
    return line.segments.map((s, si) => (
      <span key={si} style={segmentStyle(s, foreground)} className={segmentClassName(s)}>
        {renderCells(s.text)}
      </span>
    ));
  }
  const nodes: ReactNode[] = [];
  let at = 0;
  for (const { start, end, target } of links) {
    if (start > at) nodes.push(...styledSlice(line.segments, at, start, foreground));
    nodes.push(
      <a
        key={`link:${start}`}
        href={target.href}
        onClick={(e) => {
          if (e.defaultPrevented || !isPlainClick(e)) return;
          e.preventDefault();
          target.onOpen();
        }}
        className={MIRROR_LINK_CLASS}
      >
        {styledSlice(line.segments, start, end, foreground)}
      </a>,
    );
    at = end;
  }
  if (at < text.length) nodes.push(...styledSlice(line.segments, at, text.length, foreground));
  return nodes;
}

/**
 * The raw region a lifted card replaced, mirrored verbatim — the ONE implementation shared by
 * every card's terminal-mode toggle (ADR 0056) plus the two cards that used to inline this
 * themselves (the generic menu and the unread-dialog card). Same treatment as the pane mirror:
 * React text nodes only (the XSS boundary is unchanged — nothing is ever set as innerHTML), and
 * the agent's own terminal colours (MIRROR_SPACE / MIRROR_INVERT, ADR 0002). Scrolls horizontally
 * on its own so a wide screen never makes the page pan.
 *
 * `wrap` breaks long rows instead, anywhere, the way the pane mirror's Wrap does: the prompt card's
 * subject (a command, a diff, a warning) must be readable at phone width without a sideways pan.
 * `className` adds to the box, e.g. a height cap with its own vertical scroll; `ref` reaches the
 * <pre>, the element that scrolls, for a caller that measures it.
 */
export function RawMirror({
  lines,
  wrap = false,
  className,
  ref,
}: {
  lines: StyledLine[];
  wrap?: boolean;
  className?: string;
  ref?: Ref<HTMLPreElement>;
}) {
  const open = useFileLinks();
  const { colors, nativeMirror } = useContext(RawMirrorAppearanceContext);
  const paint = colors && (colors.foreground !== "" || colors.background !== "") ? colors : undefined;
  const native = paint === undefined && nativeMirror;
  return (
    <pre
      ref={ref}
      className={cn(
        "m-0 rounded-lg px-2 py-1.5 font-mono text-[11px] leading-[1.25]",
        wrap ? "whitespace-pre-wrap wrap-anywhere" : "overflow-x-auto whitespace-pre",
        native ? MUSE_MIRROR : MIRROR_SPACE,
        paint === undefined && !native && MIRROR_INVERT,
        className,
      )}
      style={paint === undefined ? undefined : mirrorColorStyle(paint)}
    >
      {lines.map((line, li) => (
        <span key={li}>
          {li > 0 ? "\n" : null}
          <MirrorRow line={line} open={open} foreground={paint?.foreground} />
        </span>
      ))}
    </pre>
  );
}
