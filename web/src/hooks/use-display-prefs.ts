import { useCallback, useState } from "react";
import type { CSSProperties } from "react";
import {
  asJsonBoolean,
  asJsonNumber,
  asJsonObject,
  asJsonString,
  parseJsonObject,
} from "@/lib/json";

// Terminal mirror display preferences, persisted in localStorage.
// Safe to call in SSR contexts (localStorage guarded throughout).

export interface DisplayPrefs {
  /** Whether the mirror wraps long lines (default: false on this fork). Upstream wraps by default
   *  (issue #53: the mirror is mostly agent prose and a phone shows ~45-50 columns). The Young
   *  Security fork keeps column-faithful output as the default and pans horizontally, because
   *  TUI tables and box drawing are what its operators read most. Wrapping stays one tap away in
   *  the Display sheet. */
  wrap: boolean;
  /** Font size in px for the mirror pre (default: 12, range: 9–16). */
  fontSize: number;
  /**
   * Font size in px for the COMPOSER's draft field (default: 14, range: 13–16).
   *
   * Its own number, and not the mirror's: the two surfaces are read differently. The mirror is a
   * wall of agent output you scan, so it wants to be small and dense; the draft is a line or two you
   * are writing and re-reading, so it wants to be comfortable. One knob would make every choice a
   * compromise between the two.
   *
   * The default drops from the fixed 16 the field used to wear. 16 is not a design choice — it is
   * the primitive's size, kept because a sub-16px focused input makes iOS Safari zoom the whole page
   * (see {@link applyDraftFontSize}, which is where that fact is now handled honestly). At 16 the
   * field runs out of width sooner than the sentence does, and a wrapped two-line draft costs the
   * mirror above it a row. 14 reads the same on a phone and buys back roughly an eighth of the line.
   *
   * The RANGE is narrower than the mirror's at both ends and that is deliberate. Below 13 a field
   * you type into stops being comfortable on a phone at arm's length, and above 16 the draft would
   * out-shout the terminal text it is a reply to. Nothing here can produce an iOS zoom either: 13 is
   * a stored preference, and the clamp at the call site is what the browser sees.
   */
  draftFontSize: number;
  /** Terminal mirror font family, as a key into FONT_STACKS (default: "system" — the app's own
   *  `--font-mono`, i.e. exactly what every install rendered before this setting existed). */
  fontFamily: FontFamily;
  /**
   * The mirror's default foreground on this device, as a six-digit `#rrggbb`, or "" for the
   * mirror's own dark-space `#fafafa` (default). Young Security fork.
   *
   * A DEFAULT, not a palette: it is what text renders in when the agent named no colour, so explicit
   * ANSI and truecolor from the agent still win, exactly as they do against `#fafafa`. Set together
   * with {@link terminalBackground} the pair is ABSOLUTE: the light theme does not invert a mirror
   * the operator coloured by hand (ADR 0002, fork amendment). Stored per device, like every display
   * pref, because a colour is a reading choice for one screen, not a property of the pane.
   */
  terminalForeground: string;
  /** The mirror's ground on this device, `#rrggbb` or "" for its own `#0a0a0a`. See
   *  {@link terminalForeground}; the two travel together. */
  terminalBackground: string;
  /**
   * Raw-terminal escape hatch (default: false). When on, the mirror renders the PLAIN terminal —
   * every Claude grammar (chrome stripping, native prompt-select buttons, the status strip) is
   * bypassed, so a misdetected/mis-rendered dialog can always be driven manually with the keys pad.
   * The universal fallback, made user-controllable.
   */
  rawTerminal: boolean;
  /**
   * Whether a tap on the terminal mirror focuses the composer (default: true).
   *
   * On, it is the fastest path from reading to replying — the whole mirror is one big "start typing"
   * target. Off, the mirror is a document: taps land on the text, so you can put a caret in it, and
   * the keyboard only appears when you tap the composer itself. Reported from the outside as the
   * mirror "absorbing the click", by someone expecting to interact with a line rather than reply to
   * it — which Collie cannot offer (herdr's `pane.read` strips the OSC 8 hyperlinks a terminal like
   * Termux makes tappable, so the link target never reaches us). Getting out of the way is the part
   * that IS ours to give.
   */
  tapToFocus: boolean;
}

/** The terminal font families offered in Settings. A closed list, not a free-text box: an
 *  unvalidatable font name typed on a phone is a footgun, and every entry here has to satisfy two
 *  invariants that a typed name cannot. */
export const FONT_FAMILIES = [
  "system",
  "jetbrains",
  "cascadia",
  "menlo",
  "roboto",
  "dejavu",
  "courier",
  "meslo",
] as const;

export type FontFamily = (typeof FONT_FAMILIES)[number];

/** The two colours the operator may paint the mirror in. "" on either side means the mirror's own
 *  dark-space value for that side. */
export interface TerminalColors {
  foreground: string;
  background: string;
}

/** The fork's one preset: phosphor green on black, tuned against the `meslo` face. */
export const MATRIX_TERMINAL_COLORS: TerminalColors = { foreground: "#00ff00", background: "#000000" };

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Narrow a colour of unknown provenance (a stored pref, an `<input type="color">` value) to the
 *  one form the mirror accepts: six-digit `#rrggbb`, lower-cased. Anything else, including a CSS
 *  colour name or a `rgb()` function, reads as "" and the mirror keeps its own value. The shape is
 *  the same one `<input type="color">` emits, so the picker never has to be normalised twice. */
export function cleanColor(value: string | undefined): string {
  return value !== undefined && HEX_COLOR.test(value) ? value.toLowerCase() : "";
}

/** The operator's colours, or undefined when both are at their default. The undefined branch is
 *  the one every mirror surface must treat as "untouched": dark ground, inverted in light. */
export function customTerminalColors(
  prefs: Pick<DisplayPrefs, "terminalForeground" | "terminalBackground">,
): TerminalColors | undefined {
  if (prefs.terminalForeground === "" && prefs.terminalBackground === "") return undefined;
  return { foreground: prefs.terminalForeground, background: prefs.terminalBackground };
}

/** Narrow a string of unknown provenance (a stored pref, a <select> value) to a FontFamily. */
export function isFontFamily(value: string): value is FontFamily {
  return FONT_FAMILIES.some((family) => family === value);
}

// The two invariants every stack below keeps, and why:
//
//   1. `"Nerd Font Symbols"` LEADS, always. It is the bundled webfont, and it is safe in first
//      position only because its `@font-face` blocks carry a private-use `unicode-range` — see the
//      long comment above them in index.css. It can never be consulted for a letter, a digit or a
//      box-drawing character, so the real monospace face still sets the metrics. Drop it from a
//      stack and every Powerline separator and devicon in that agent's output becomes tofu.
//   2. Each stack ENDS in the generic `monospace`, via the same tail the app's own `--font-mono`
//      ends in. A stack that fell through to a proportional face would destroy the mirror's column
//      alignment, which is the one thing the mirror exists to preserve. So an absent family
//      degrades to the platform's monospace — visually, to exactly what "System default" gives.
//
// TAIL is the non-Nerd remainder of `--font-mono` (index.css). Kept in sync by hand, deliberately:
// "system" below resolves to `undefined` and writes nothing, so the DEFAULT path reads the CSS and
// this constant can never drift the untouched case.
const NERD = '"Nerd Font Symbols"';
const TAIL =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/** family key → `font-family` value, or undefined for "system" (leave the stylesheet alone). */
export const FONT_STACKS = {
  system: undefined,
  // Bundled with many editors and shipped by several Linux distributions; already first in the
  // app's own stack, so this is "prefer it, and say so".
  jetbrains: `${NERD}, "JetBrains Mono", ${TAIL}`,
  // Windows 11 / Windows Terminal.
  cascadia: `${NERD}, "Cascadia Mono", "Cascadia Code", ${TAIL}`,
  // Apple: present on every macOS and iOS device. SF Mono where the browser exposes it.
  menlo: `${NERD}, Menlo, "SF Mono", ui-monospace, ${TAIL}`,
  // Android and Chrome OS; also common on Linux.
  roboto: `${NERD}, "Roboto Mono", "Droid Sans Mono", ${TAIL}`,
  // The Linux desktop pair — one of the two is on essentially every distribution.
  dejavu: `${NERD}, "DejaVu Sans Mono", "Liberation Mono", ${TAIL}`,
  // The universal fallback face, and the only genuinely different silhouette on offer: thin,
  // wide-spaced, serifed. Present on Windows, macOS and iOS; Linux resolves it via fontconfig.
  courier: `${NERD}, "Courier New", Courier, ${TAIL}`,
  // Young Security fork: the patched Meslo the Powerlevel10k / Oh My Posh guides install, under
  // both names its releases have shipped. It is the face the fork's Matrix colour preset was tuned
  // against, and the one the fork's phones were already on before the family list became closed.
  // Menlo is its unpatched parent, so it is the nearest fallback before the shared tail.
  meslo: `${NERD}, "MesloLGS NF", "MesloLGS Nerd Font", Menlo, ${TAIL}`,
} satisfies Record<FontFamily, string | undefined>;

/** A family's `font-family` value, or undefined for "system" — where the app default already
 *  applies and nothing should be written at all. */
export function fontStack(family: FontFamily): string | undefined {
  return FONT_STACKS[family];
}

/** What a mirror surface needs in order to render in the chosen family: a class and a style, both
 *  empty/undefined for the default family so that surface is left exactly as it was. */
export interface MirrorFont {
  /** Goes on the surface, alongside its existing classes. */
  className: string;
  /** Goes on the same element's `style`. */
  style: CSSProperties | undefined;
}

const MIRROR_FONT_NONE: MirrorFont = { className: "", style: undefined };

// WHY THIS IS A CLASS PLUS AN INLINE STYLE, AND NOT A CUSTOM PROPERTY.
//
// The obvious move is to re-point `--font-mono` on the mirror's root and let every `font-mono`
// descendant follow. It does not work here, and the reason is worth writing down so nobody spends
// the afternoon on it twice: `index.css` declares the token inside `@theme inline`, and `inline` is
// exactly the instruction to SUBSTITUTE the value rather than emit `var()`. Tailwind therefore
// compiles `.font-mono` to the literal font stack. Overriding the property at runtime changes
// nothing, and only editing that stylesheet could change that.
//
// So the family is applied as `font-family` on the mirror surface itself — an inline style, which
// outranks the `.font-mono` class — plus one arbitrary variant that makes the surface's own
// `font-mono` DESCENDANTS inherit it instead of re-asserting the literal. The dialog blocks
// AnsiOutput renders as siblings of the <pre> are reached that way without a prop threaded into
// each of them, so no mirror surface can be forgotten and drift into a second face.
//
// `.mirror-font .font-mono` is specificity (0,2,0) against `.font-mono`'s (0,1,0), so it wins, and
// both sit in the same `utilities` layer.
const MIRROR_FONT_CLASS = "[&_.font-mono]:[font-family:inherit]";

/** The class+style pair that renders a mirror surface in the chosen family. The default family
 *  yields an empty class and no style at all, so an install that never opened the setting renders
 *  from the stylesheet alone, byte for byte as before. */
export function mirrorFont(family: FontFamily): MirrorFont {
  const stack = fontStack(family);
  if (stack === undefined) return MIRROR_FONT_NONE;
  return { className: MIRROR_FONT_CLASS, style: { fontFamily: stack } };
}

// NOT bumped for `tapToFocus`: loadPrefs defaults each field independently, so a v4 payload written
// before it existed simply reads the default. Bumping would silently reset everyone's wrap, size and
// raw-terminal choice to buy nothing.
const STORAGE_KEY = "collie:display-prefs:v4";
export const FONT_MIN = 9;
export const FONT_MAX = 16;
/** The draft field's own range — see `draftFontSize` on {@link DisplayPrefs} for why it is narrower
 *  than the mirror's at both ends. */
export const DRAFT_FONT_MIN = 13;
export const DRAFT_FONT_MAX = 16;
const DEFAULTS: DisplayPrefs = {
  wrap: false,
  fontSize: 12,
  draftFontSize: 14,
  fontFamily: "system",
  terminalForeground: "",
  terminalBackground: "",
  rawTerminal: false,
  tapToFocus: true,
};

function readFontFamily(value: string | undefined): FontFamily | undefined {
  return value !== undefined && isFontFamily(value) ? value : undefined;
}

// YOUNG SECURITY FORK: the shape this key held before the 1.1.0 adoption.
//
// Between 0.31 and 0.36.1 the fork stored a `terminal` object under this SAME key, holding a
// free-text font name and the two colours. Upstream 1.1.0 reads the key field by field and ignores
// the object, so without this block a phone that was on MesloLGS NF in green-on-black would have
// silently come up in the system face on the dark ground, and its next save would have dropped the
// object for good. The key is deliberately not bumped: every other field is read exactly as before,
// and a bump would have reset wrap, size and raw-terminal on every device to buy nothing.
//
// The font is the lossy half. The free-text field became a closed list, so the old name is matched
// case-insensitively against the names the list's stacks actually contain (first family of a
// comma-separated value, quotes stripped), and anything else reads as "system". The colours pass
// through cleanColor unchanged. The 1.1.0 fields, when present, win over the object; the next save
// writes the new shape and the object is gone.
const LEGACY_FONT_NAMES: ReadonlyMap<string, FontFamily> = new Map([
  ["meslolgs nf", "meslo"],
  ["meslolgs nerd font", "meslo"],
  ["jetbrains mono", "jetbrains"],
  ["cascadia mono", "cascadia"],
  ["cascadia code", "cascadia"],
  ["roboto mono", "roboto"],
  ["menlo", "menlo"],
  ["sf mono", "menlo"],
  ["dejavu sans mono", "dejavu"],
  ["courier new", "courier"],
]);

function legacyFontFamily(name: string | undefined): FontFamily | undefined {
  if (name === undefined) return undefined;
  const first = name.split(",")[0] ?? "";
  return LEGACY_FONT_NAMES.get(first.trim().replace(/^["']|["']$/g, "").trim().toLowerCase());
}

function clampFont(n: number): number {
  return Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)));
}

function clampDraftFont(n: number): number {
  return Math.max(DRAFT_FONT_MIN, Math.min(DRAFT_FONT_MAX, Math.round(n)));
}

/**
 * The smallest `font-size` a focused text field may carry on iOS without the page zooming.
 *
 * Mobile Safari zooms the viewport to the focused field whenever that field's computed font-size is
 * under 16px, and it does NOT zoom back out when the field blurs — so one tap on the composer
 * leaves the operator's whole screen magnified, with the mirror above it cropped, and the way back
 * is a manual pinch. It is not a preference, a setting or a bug we can file: it is what the engine
 * does, and every engine on iOS is that engine.
 */
export const IOS_NO_ZOOM_FONT_PX = 16;

/**
 * Whether this browser zooms the page when a small field takes focus — i.e. whether it is WebKit on
 * an Apple touch device.
 *
 * DELIBERATELY CONSERVATIVE, in the direction that costs the least. A false positive costs an iPhone
 * user 2px of draft text they asked to give up; a false negative costs an iOS user a zoomed, cropped
 * screen they cannot get out of without pinching. So the predicate demands BOTH halves — an Apple
 * platform AND a touch digitiser — rather than either alone:
 *
 *   • `maxTouchPoints > 0` alone matches a Windows laptop with a touchscreen, which does not zoom.
 *   • An Apple platform alone matches a desktop Mac, which has no viewport zoom to trigger.
 *   • iPadOS reports its platform as "MacIntel" and is indistinguishable from a desktop Mac by
 *     platform string. The touch half is exactly what separates them, which is the other reason the
 *     two are ANDed rather than ORed.
 *
 * `navigator.platform` is deprecated and still the only string here that is not routinely spoofed by
 * a "request desktop site" toggle, so the user-agent is consulted as well and either may carry the
 * Apple half. Absent both (SSR, a stub in tests) the answer is false and the operator's own number
 * applies untouched.
 */
export function inputFocusZoomsPage(): boolean {
  if (typeof navigator === "undefined") return false;
  const touch = navigator.maxTouchPoints > 0;
  const apple = /iPhone|iPad|iPod|Mac/.test(`${navigator.platform} ${navigator.userAgent}`);
  return touch && apple;
}

/**
 * The px the draft field actually renders at: the operator's preference, raised to
 * {@link IOS_NO_ZOOM_FONT_PX} where a smaller one would zoom the page.
 *
 * Pure, with the browser fact passed IN rather than probed here, so both branches are testable in
 * jsdom — which reports no touch points and would otherwise only ever exercise one of them. The
 * clamp is a floor and never a ceiling: it can only ever make the text bigger, so an operator on iOS
 * who wants 16 gets exactly what they asked for and one who asked for 13 gets a readable field
 * instead of a magnified screen. The setting's own description says so, because a stepper whose
 * lower half silently does nothing is worse than one that explains itself.
 */
export function applyDraftFontSize(pref: number, zoomsOnSmallInput: boolean): number {
  const size = clampDraftFont(pref);
  return zoomsOnSmallInput ? Math.max(size, IOS_NO_ZOOM_FONT_PX) : size;
}

function loadPrefs(): DisplayPrefs {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return DEFAULTS;
    const p = parseJsonObject(raw);
    if (!p) return DEFAULTS;
    const fontSize = asJsonNumber(p.fontSize);
    const draftFontSize = asJsonNumber(p.draftFontSize);
    const legacyTerminal = asJsonObject(p.terminal);
    return {
      wrap: asJsonBoolean(p.wrap) ?? DEFAULTS.wrap,
      fontSize: fontSize === undefined ? DEFAULTS.fontSize : clampFont(fontSize),
      // Same independent-default rule as every field around it: a payload written before the draft
      // had its own size reads 14, which is the change this shipped. Nobody's mirror size moves.
      draftFontSize:
        draftFontSize === undefined ? DEFAULTS.draftFontSize : clampDraftFont(draftFontSize),
      // Same independent-default rule as the fields above it, so a payload written before the
      // family existed reads "system" — an existing install sees no change at all. The fork's old
      // `terminal` object is consulted only when the 1.1.0 field is absent (see LEGACY_FONT_NAMES).
      fontFamily:
        readFontFamily(asJsonString(p.fontFamily)) ??
        legacyFontFamily(asJsonString(legacyTerminal?.fontFamily)) ??
        DEFAULTS.fontFamily,
      terminalForeground: cleanColor(
        asJsonString(p.terminalForeground) ?? asJsonString(legacyTerminal?.foreground),
      ),
      terminalBackground: cleanColor(
        asJsonString(p.terminalBackground) ?? asJsonString(legacyTerminal?.background),
      ),
      rawTerminal: asJsonBoolean(p.rawTerminal) ?? DEFAULTS.rawTerminal,
      tapToFocus: asJsonBoolean(p.tapToFocus) ?? DEFAULTS.tapToFocus,
    };
  } catch {
    return DEFAULTS;
  }
}

function savePrefs(prefs: DisplayPrefs): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    }
  } catch {
    // Ignore quota / SSR write errors.
  }
}

export interface UseDisplayPrefsReturn {
  prefs: DisplayPrefs;
  /** Toggle or explicitly set line-wrap. */
  setWrap: (wrap: boolean) => void;
  /** Set font size, clamped to 9–16. */
  setFontSize: (size: number) => void;
  /** Set the mirror font family. */
  setFontFamily: (family: FontFamily) => void;
  /** Set both mirror colours at once, each normalised by cleanColor; pass "" to restore a side. */
  setTerminalColors: (colors: TerminalColors) => void;
  /** Step font size by delta (positive = larger), clamped to 9–16. */
  stepFontSize: (delta: number) => void;
  /** Step the draft field's size by delta (positive = larger), clamped to 13–16. */
  stepDraftFontSize: (delta: number) => void;
  /** Toggle or explicitly set the raw-terminal escape hatch. */
  setRawTerminal: (raw: boolean) => void;
  /** Toggle or explicitly set whether a mirror tap focuses the composer. */
  setTapToFocus: (tapToFocus: boolean) => void;
}

export function useDisplayPrefs(): UseDisplayPrefsReturn {
  const [prefs, setPrefs] = useState<DisplayPrefs>(loadPrefs);

  const setWrap = useCallback((wrap: boolean) => {
    setPrefs((p) => {
      const next: DisplayPrefs = { ...p, wrap };
      savePrefs(next);
      return next;
    });
  }, []);

  const setFontSize = useCallback((size: number) => {
    setPrefs((p) => {
      const next: DisplayPrefs = { ...p, fontSize: clampFont(size) };
      savePrefs(next);
      return next;
    });
  }, []);

  const setFontFamily = useCallback((fontFamily: FontFamily) => {
    setPrefs((p) => {
      const next: DisplayPrefs = { ...p, fontFamily };
      savePrefs(next);
      return next;
    });
  }, []);

  const setTerminalColors = useCallback((colors: TerminalColors) => {
    setPrefs((p) => {
      const next: DisplayPrefs = {
        ...p,
        terminalForeground: cleanColor(colors.foreground),
        terminalBackground: cleanColor(colors.background),
      };
      savePrefs(next);
      return next;
    });
  }, []);

  const stepFontSize = useCallback((delta: number) => {
    setPrefs((p) => {
      const next: DisplayPrefs = { ...p, fontSize: clampFont(p.fontSize + delta) };
      savePrefs(next);
      return next;
    });
  }, []);

  const stepDraftFontSize = useCallback((delta: number) => {
    setPrefs((p) => {
      const next: DisplayPrefs = { ...p, draftFontSize: clampDraftFont(p.draftFontSize + delta) };
      savePrefs(next);
      return next;
    });
  }, []);

  const setRawTerminal = useCallback((rawTerminal: boolean) => {
    setPrefs((p) => {
      const next: DisplayPrefs = { ...p, rawTerminal };
      savePrefs(next);
      return next;
    });
  }, []);

  const setTapToFocus = useCallback((tapToFocus: boolean) => {
    setPrefs((p) => {
      const next: DisplayPrefs = { ...p, tapToFocus };
      savePrefs(next);
      return next;
    });
  }, []);

  return {
    prefs,
    setWrap,
    setFontSize,
    setFontFamily,
    setTerminalColors,
    stepFontSize,
    stepDraftFontSize,
    setRawTerminal,
    setTapToFocus,
  };
}
