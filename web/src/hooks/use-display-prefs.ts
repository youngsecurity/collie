import { useCallback, useState } from "react";

// Terminal mirror display preferences, persisted in localStorage.
// Safe to call in SSR contexts (localStorage guarded throughout).

export interface DisplayPrefs {
  /** Whether the mirror wraps long lines (default: false — preserves column-faithful TUI output). */
  wrap: boolean;
  /** Font size in px for the mirror pre (default: 12, range: 9–16). */
  fontSize: number;
  /**
   * Raw-terminal escape hatch (default: false). When on, the mirror renders the PLAIN terminal —
   * every Claude grammar (chrome stripping, native prompt-select buttons, the status strip) is
   * bypassed, so a misdetected/mis-rendered dialog can always be driven manually with the keys pad.
   * The universal fallback, made user-controllable.
   */
  rawTerminal: boolean;
  /** Device-local terminal mirror appearance. Empty values inherit Collie's app theme/font stack. */
  terminal: TerminalAppearance;
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

export interface TerminalAppearance {
  /** CSS font-family value. The font must be installed on the device running the browser. */
  fontFamily: string;
  /** Six-digit CSS hex color, or empty to inherit Collie's foreground. */
  foreground: string;
  /** Six-digit CSS hex color, or empty for Collie's existing transparent background. */
  background: string;
}

export const DEFAULT_TERMINAL_APPEARANCE: TerminalAppearance = {
  fontFamily: "",
  foreground: "",
  background: "",
};

export const MATRIX_TERMINAL_APPEARANCE: TerminalAppearance = {
  fontFamily: "MesloLGS NF",
  foreground: "#00ff00",
  background: "#000000",
};

// NOT bumped for `tapToFocus`: parsePrefs defaults each field independently, so a v4 payload written
// before it existed keeps wrap, size, raw-terminal, and terminal appearance. The v3 migration retains
// Young Security appearance settings saved before the fork moved to upstream's v4 key.
const STORAGE_KEY = "collie:display-prefs:v4";
const LEGACY_STORAGE_KEY = "collie:display-prefs:v3";
export const FONT_MIN = 9;
export const FONT_MAX = 16;
const DEFAULTS: DisplayPrefs = {
  wrap: false,
  fontSize: 12,
  rawTerminal: false,
  terminal: DEFAULT_TERMINAL_APPEARANCE,
  tapToFocus: true,
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const FONT_FAMILY_MAX = 160;

function cleanFontFamily(value: unknown, trim = true): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "");
  return (trim ? cleaned.trim() : cleaned).slice(0, FONT_FAMILY_MAX);
}

function cleanColor(value: unknown): string {
  if (typeof value !== "string" || !HEX_COLOR.test(value)) return "";
  return value.toLowerCase();
}

function cleanTerminalAppearance(value: unknown, trimFont = true): TerminalAppearance {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_TERMINAL_APPEARANCE };
  const terminal = value as Record<string, unknown>;
  return {
    fontFamily: cleanFontFamily(terminal.fontFamily, trimFont),
    foreground: cleanColor(terminal.foreground),
    background: cleanColor(terminal.background),
  };
}

function clampFont(n: number): number {
  return Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)));
}

function parsePrefs(raw: string): DisplayPrefs | null {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  return {
    wrap: typeof p.wrap === "boolean" ? p.wrap : DEFAULTS.wrap,
    fontSize: typeof p.fontSize === "number" ? clampFont(p.fontSize) : DEFAULTS.fontSize,
    rawTerminal: typeof p.rawTerminal === "boolean" ? p.rawTerminal : DEFAULTS.rawTerminal,
    terminal: cleanTerminalAppearance(p.terminal),
    tapToFocus: typeof p.tapToFocus === "boolean" ? p.tapToFocus : DEFAULTS.tapToFocus,
  };
}

function loadPrefs(): DisplayPrefs {
  try {
    if (typeof localStorage === "undefined") return DEFAULTS;

    const current = localStorage.getItem(STORAGE_KEY);
    if (current) return parsePrefs(current) ?? DEFAULTS;

    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!legacy) return DEFAULTS;

    const migrated = parsePrefs(legacy);
    if (!migrated) return DEFAULTS;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    return migrated;
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
  /** Step font size by delta (positive = larger), clamped to 9–16. */
  stepFontSize: (delta: number) => void;
  /** Toggle or explicitly set the raw-terminal escape hatch. */
  setRawTerminal: (raw: boolean) => void;
  /** Replace the terminal mirror appearance after normalising font and color values. */
  setTerminalAppearance: (appearance: TerminalAppearance) => void;
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

  const stepFontSize = useCallback((delta: number) => {
    setPrefs((p) => {
      const next: DisplayPrefs = { ...p, fontSize: clampFont(p.fontSize + delta) };
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

  const setTerminalAppearance = useCallback((appearance: TerminalAppearance) => {
    setPrefs((p) => {
      // Preserve an in-progress trailing space while the controlled font field is being typed. The
      // field trims on blur, and loadPrefs trims again when restoring persisted data.
      const next: DisplayPrefs = { ...p, terminal: cleanTerminalAppearance(appearance, false) };
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
    stepFontSize,
    setRawTerminal,
    setTerminalAppearance,
    setTapToFocus,
  };
}
