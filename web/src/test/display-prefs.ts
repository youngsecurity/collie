import type { DisplayPrefs } from "@/hooks/use-display-prefs";

// The one place a test spells a full DisplayPrefs. Every new field on the type used to mean editing
// eleven literals across the composer suites by hand (the fontFamily commit did exactly that); a
// fixture that starts from the defaults and takes overrides means the type grows and the suites
// follow without a diff. Keep the base identical to the hook's DEFAULTS except where a test's
// history says otherwise (the composer suites were written against fontSize 11 and wrap on).

const BASE: DisplayPrefs = {
  wrap: true,
  fontSize: 11,
  draftFontSize: 14,
  fontFamily: "system",
  terminalForeground: "",
  terminalBackground: "",
  rawTerminal: false,
  tapToFocus: true,
};

/** A full DisplayPrefs for a test to hand to a component, with any fields it cares about set. */
export function displayPrefs(overrides: Partial<DisplayPrefs> = {}): DisplayPrefs {
  return { ...BASE, ...overrides };
}
