// The mirror's colour space, shared by every surface that renders terminal segments verbatim.
//
// Terminal colour is DARK-space colour: an agent picks bright yellow because it will sit on a near
// black background. So these surfaces are authored in dark space under every theme and the light
// theme inverts them wholesale, rather than re-theming the palette. See
// .adr/0002-invert-the-light-terminal-mirror.md — in short, three of the four harnesses emit
// overwhelmingly truecolor (opencode 100%, pi 89%, claude 79%), and truecolor names an absolute
// colour no palette can re-theme. Rendering it unchanged on white leaves most of an agent's output
// under 2:1.
//
// TWO surfaces need this now — the pane mirror's <pre> and the statusline strip above the composer —
// which is why it lives here instead of being spelled twice and drifting, the silent-failure class
// the ADR is about. The interactive blocks (prompt/wizard/preview/multi-select) are siblings of the
// mirror, not children, so they keep normal app theming and never invert.
//
// The colours are LITERAL dark-space values rather than theme tokens. That is a CONVENTION, not a
// constraint: `color-scheme: dark` on the element DOES flip an inherited light-dark() token
// (resolution is element-scoped, per spec), and these literals are byte-exact matches for
// --background / --foreground / --muted-foreground's dark halves, so either spelling renders the
// same pixels. Literals win because they sit beside the truecolor an agent emits — which nothing can
// re-theme — and say at the point of use that the value is deliberately theme-independent. What
// matters is that a mirror surface never mixes the two (ADR 0002, rule 2).
//
// `color-scheme: dark` still earns its place for native UI inside these surfaces (the x-overflow
// scrollbar, selection), which the filter then maps to light along with everything else.
//
// NEVER add a `dark:` variant inside one: it tracks the ROOT theme, which is backwards in an element
// that is dark under every theme and inverts in light.
//
// THE ONE EXCEPTION TO "DARK GROUND, INVERTED IN LIGHT" (Young Security fork): a surface the
// operator has coloured by hand. Settings lets a device pick the mirror's default foreground and
// background, and those are ABSOLUTE: the operator chose green on black and gets green on black
// under both themes. So a painted surface carries `mirrorColorStyle()` inline (which outranks the
// MIRROR_SPACE classes) and does NOT carry MIRROR_INVERT. The agent's own explicit colours still win
// over the default foreground, exactly as they win over #fafafa, so this re-grounds the mirror
// without re-theming anything the agent said. See the fork amendment appended to ADR 0002.
import type { CSSProperties } from "react";

import type { TerminalColors } from "@/hooks/use-display-prefs";
import type { AnsiSegment } from "@/lib/ansi";

export const MIRROR_SPACE = "[color-scheme:dark] bg-[#0a0a0a] text-[#fafafa]";
export const MIRROR_INVERT = "[filter:invert(1)_hue-rotate(180deg)] dark:[filter:none]";

/** --muted-foreground's dark half, written literally to match MIRROR_SPACE. */
const MIRROR_MUTED = "#a1a1a1";

/** A segment's inline style. `muted` is the parser's own "this is TUI chrome" mark rather than an
 *  ANSI colour: drop the ANSI dim opacity so box-drawing and rule glyphs stay visible (var(--border)
 *  + dim was nearly invisible on mobile). A rule the agent coloured explicitly keeps that colour; one
 *  it did not resolves to the operator's default foreground where the surface has one (fork), else
 *  to #a1a1a1, since everything on these surfaces is dark-space. */
export function styleFor(s: AnsiSegment, foreground = ""): CSSProperties {
  if (!s.muted) return s.style;
  const fallback = foreground === "" ? MIRROR_MUTED : foreground;
  return { ...s.style, color: s.style.color ?? fallback, fontWeight: 400, opacity: 1 };
}

/** An inline style that may also set the two custom properties lib/ansi.ts's inverse-video
 *  fallbacks read. React's CSSProperties has no index signature, so the two names are spelled. */
export interface MirrorColorStyle extends CSSProperties {
  "--terminal-foreground"?: string;
  "--terminal-background"?: string;
}

/** The inline style that paints a mirror surface in the operator's colours: each side that is set
 *  becomes the element's own colour AND the custom property inverse video swaps to. A side left ""
 *  writes nothing, so the MIRROR_SPACE class keeps that side. */
export function mirrorColorStyle(colors: TerminalColors): MirrorColorStyle {
  const style: MirrorColorStyle = {};
  if (colors.foreground !== "") {
    style.color = colors.foreground;
    style["--terminal-foreground"] = colors.foreground;
  }
  if (colors.background !== "") {
    style.backgroundColor = colors.background;
    style["--terminal-background"] = colors.background;
  }
  return style;
}
