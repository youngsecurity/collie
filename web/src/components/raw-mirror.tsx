import { createContext, useContext } from "react";
import type { StyledLine } from "@/lib/blocks";
import type { TerminalColors } from "@/hooks/use-display-prefs";
import {
  MIRROR_INVERT, MIRROR_SPACE, MUSE_MIRROR, mirrorColorStyle, segmentClassName, segmentStyle,
} from "@/components/mirror-space";
import { renderCells } from "@/components/painted-cells";
import { cn } from "@/lib/utils";

export interface RawMirrorAppearance {
  colors?: TerminalColors;
  nativeMirror?: boolean;
}

// A lifted card can replace the whole mirror. Its direct rows and PromptPanel's Terminal view
// must share the caller's appearance without teaching every dialog grammar about preferences.
export const RawMirrorAppearanceContext = createContext<RawMirrorAppearance>({});

/**
 * The raw region a lifted card replaced, mirrored verbatim — the ONE implementation shared by
 * every card's terminal-mode toggle (ADR 0056) plus the two cards that used to inline this
 * themselves (the generic menu and the unread-dialog card). Same treatment as the pane mirror:
 * React text nodes only (the XSS boundary is unchanged — nothing is ever set as innerHTML), and
 * the agent's own terminal colours (MIRROR_SPACE / MIRROR_INVERT, ADR 0002). Scrolls horizontally
 * on its own so a wide screen never makes the page pan.
 */
export function RawMirror({ lines }: { lines: StyledLine[] }) {
  const { colors, nativeMirror } = useContext(RawMirrorAppearanceContext);
  const paint = colors && (colors.foreground !== "" || colors.background !== "") ? colors : undefined;
  const native = paint === undefined && nativeMirror;
  return (
    <pre
      className={cn(
        "m-0 overflow-x-auto rounded-lg px-2 py-1.5 font-mono text-[11px] leading-[1.25] whitespace-pre",
        native ? MUSE_MIRROR : MIRROR_SPACE,
        paint === undefined && !native && MIRROR_INVERT,
      )}
      style={paint === undefined ? undefined : mirrorColorStyle(paint)}
    >
      {lines.map((line, li) => (
        <span key={li}>
          {li > 0 ? "\n" : null}
          {line.segments.map((s, si) => (
            <span key={si} style={segmentStyle(s, paint?.foreground)} className={segmentClassName(s)}>
              {renderCells(s.text)}
            </span>
          ))}
        </span>
      ))}
    </pre>
  );
}
