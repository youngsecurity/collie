import { renderHook, act } from "@testing-library/react";
import {
  applyDraftFontSize,
  cleanColor,
  customTerminalColors,
  DRAFT_FONT_MAX,
  DRAFT_FONT_MIN,
  FONT_FAMILIES,
  FONT_STACKS,
  fontStack,
  inputFocusZoomsPage,
  IOS_NO_ZOOM_FONT_PX,
  MATRIX_TERMINAL_COLORS,
  mirrorFont,
  useDisplayPrefs,
} from "./use-display-prefs";

// Minimal localStorage stub — Vitest/jsdom includes a real one but this ensures it's clean per test.
const STORAGE_KEY = "collie:display-prefs:v4";

describe("useDisplayPrefs", () => {
  beforeEach(() => localStorage.clear());

  it("returns defaults when localStorage is empty", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs).toEqual({ wrap: false, fontSize: 12, draftFontSize: 14, fontFamily: "system", terminalForeground: "", terminalBackground: "", rawTerminal: false, tapToFocus: true });
  });

  it("persists wrap=true and reloads it on mount", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.setWrap(true));
    expect(result.current.prefs.wrap).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).wrap).toBe(true);
  });

  it("persists wrap=false and reloads it on mount", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.setWrap(false));
    expect(result.current.prefs.wrap).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).wrap).toBe(false);
  });

  it("loads persisted prefs from localStorage on mount", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ wrap: false, fontSize: 14, rawTerminal: true, tapToFocus: false }));
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs).toEqual({ wrap: false, fontSize: 14, draftFontSize: 14, fontFamily: "system", terminalForeground: "", terminalBackground: "", rawTerminal: true, tapToFocus: false });
  });

  it("persists rawTerminal and reloads it on mount (the escape hatch survives a reload)", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs.rawTerminal).toBe(false);
    act(() => result.current.setRawTerminal(true));
    expect(result.current.prefs.rawTerminal).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).rawTerminal).toBe(true);
    const { result: reloaded } = renderHook(() => useDisplayPrefs());
    expect(reloaded.current.prefs.rawTerminal).toBe(true);
  });

  it("persists tapToFocus and reloads it on mount", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs.tapToFocus).toBe(true);
    act(() => result.current.setTapToFocus(false));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).tapToFocus).toBe(false);
    const { result: reloaded } = renderHook(() => useDisplayPrefs());
    expect(reloaded.current.prefs.tapToFocus).toBe(false);
  });

  // The storage key was deliberately NOT bumped for tapToFocus: a payload written before it existed
  // must keep every other choice and take the default for the new one. A bump would have reset them.
  it("reads a pre-tapToFocus payload without discarding the prefs it does have", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ wrap: false, fontSize: 15, rawTerminal: true }));
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs).toEqual({ wrap: false, fontSize: 15, draftFontSize: 14, fontFamily: "system", terminalForeground: "", terminalBackground: "", rawTerminal: true, tapToFocus: true });
  });

  it("persists fontFamily and reloads it on mount", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs.fontFamily).toBe("system");
    act(() => result.current.setFontFamily("courier"));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).fontFamily).toBe("courier");
    const { result: reloaded } = renderHook(() => useDisplayPrefs());
    expect(reloaded.current.prefs.fontFamily).toBe("courier");
  });

  it("ignores an unknown stored fontFamily and keeps the rest of the payload", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ wrap: false, fontSize: 15, fontFamily: "comic-sans", rawTerminal: true }),
    );
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs.fontFamily).toBe("system");
    expect(result.current.prefs.fontSize).toBe(15);
  });

  // The two invariants the mirror depends on. Break either and the terminal is wrong in a way no
  // other test would notice: a lost Nerd entry turns every Powerline glyph into tofu, and a stack
  // that does not end in a monospace generic can fall through to a proportional face and destroy
  // the mirror's column alignment.
  it("every non-default font stack leads with Nerd Font Symbols and ends in monospace", () => {
    for (const [family, stack] of Object.entries(FONT_STACKS)) {
      if (family === "system") {
        expect(stack).toBeUndefined();
        continue;
      }
      expect(stack).toBeDefined();
      expect(stack!.startsWith('"Nerd Font Symbols", ')).toBe(true);
      expect(stack!.endsWith(", monospace")).toBe(true);
    }
  });

  // ── THE MIRROR'S COLOURS (Young Security fork) ────────────────────────────────────────────────

  it("persists terminal font and colors and reloads them on mount", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.setFontFamily("meslo"));
    act(() => result.current.setTerminalColors(MATRIX_TERMINAL_COLORS));
    expect(result.current.prefs).toMatchObject({
      fontFamily: "meslo",
      terminalForeground: "#00ff00",
      terminalBackground: "#000000",
    });
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.terminalForeground).toBe("#00ff00");
    expect(stored.terminalBackground).toBe("#000000");
    const { result: reloaded } = renderHook(() => useDisplayPrefs());
    expect(reloaded.current.prefs).toEqual(result.current.prefs);
  });

  // The value reaches an inline `style` on the mirror, so it is narrowed to the one shape the picker
  // emits. Anything else, a CSS function included, reads as "" and the mirror keeps its own ground.
  it("rejects invalid persisted colors", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        terminalForeground: "red; background:url(evil)",
        terminalBackground: "#ABCDEF",
      }),
    );
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs.terminalForeground).toBe("");
    expect(result.current.prefs.terminalBackground).toBe("#abcdef");
    expect(cleanColor("#fff")).toBe("");
    expect(cleanColor("rgb(0,255,0)")).toBe("");
    expect(cleanColor("#00FF00")).toBe("#00ff00");
  });

  it("setTerminalColors normalises through cleanColor and \"\" restores a side", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.setTerminalColors({ foreground: "#ABCDEF", background: "not-a-colour" }));
    expect(result.current.prefs.terminalForeground).toBe("#abcdef");
    expect(result.current.prefs.terminalBackground).toBe("");
    act(() => result.current.setTerminalColors({ foreground: "", background: "" }));
    expect(customTerminalColors(result.current.prefs)).toBeUndefined();
  });

  // The fork stored `{ terminal: { fontFamily, foreground, background } }` under this same key
  // before 1.1.0. The object is read once, into the 1.1.0 fields, and the next save drops it.
  it("migrates a fork v4 terminal object into the 1.1.0 fields before the first save", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        wrap: false,
        fontSize: 13,
        rawTerminal: true,
        terminal: { fontFamily: "MesloLGS NF", foreground: "#00FF00", background: "#000000" },
      }),
    );
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs).toEqual({
      wrap: false,
      fontSize: 13,
      draftFontSize: 14,
      fontFamily: "meslo",
      terminalForeground: "#00ff00",
      terminalBackground: "#000000",
      rawTerminal: true,
      tapToFocus: true,
    });
    // The first save writes the 1.1.0 shape and the legacy object is gone.
    act(() => result.current.setWrap(true));
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.terminal).toBeUndefined();
    expect(stored.fontFamily).toBe("meslo");
    expect(stored.terminalForeground).toBe("#00ff00");
  });

  it("maps every fork font name the closed list can honour, case-insensitively, else system", () => {
    const cases: Array<[string, string]> = [
      ["meslolgs nerd font", "meslo"],
      ['"MesloLGS NF", monospace', "meslo"],
      ["JetBrains Mono", "jetbrains"],
      ["Cascadia Code", "cascadia"],
      ["cascadia mono", "cascadia"],
      ["Roboto Mono", "roboto"],
      ["SF Mono", "menlo"],
      ["Menlo", "menlo"],
      ["DejaVu Sans Mono", "dejavu"],
      ["Courier New", "courier"],
      ["Comic Sans MS", "system"],
      ["", "system"],
    ];
    for (const [legacy, expected] of cases) {
      localStorage.clear();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ terminal: { fontFamily: legacy } }));
      const { result } = renderHook(() => useDisplayPrefs());
      expect(result.current.prefs.fontFamily, legacy).toBe(expected);
    }
  });

  it("lets a 1.1.0 fontFamily and colour win over a leftover fork terminal object", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        fontFamily: "courier",
        terminalForeground: "",
        terminal: { fontFamily: "MesloLGS NF", foreground: "#00ff00", background: "#000000" },
      }),
    );
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs.fontFamily).toBe("courier");
    expect(result.current.prefs.terminalForeground).toBe("");
    // The background had no 1.1.0 field yet, so the object still supplies it.
    expect(result.current.prefs.terminalBackground).toBe("#000000");
  });

  // The fork's entry. Both names Meslo's patched releases have shipped under, so a phone that
  // installed either keeps its face, with Menlo (the unpatched parent) before the shared tail.
  it("offers the fork's MesloLGS NF entry under both of its release names", () => {
    expect(FONT_FAMILIES).toContain("meslo");
    expect(FONT_STACKS.meslo).toContain('"MesloLGS NF", "MesloLGS Nerd Font", Menlo');
  });

  it("the default family writes no class and no style, so the stylesheet alone applies", () => {
    expect(fontStack("system")).toBeUndefined();
    expect(mirrorFont("system")).toEqual({ className: "", style: undefined });
  });

  // The descendant variant is the half that reaches the dialog blocks AnsiOutput renders as
  // siblings of the <pre>. Without it they keep `.font-mono`'s literal stack and the pane shows two
  // different faces at once.
  it("a chosen family sets font-family AND makes font-mono descendants inherit it", () => {
    const face = mirrorFont("courier");
    expect(face.style).toEqual({ fontFamily: FONT_STACKS.courier });
    expect(face.className).toContain("[&_.font-mono]:[font-family:inherit]");
  });

  it("setFontSize clamps below minimum to 9", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.setFontSize(3));
    expect(result.current.prefs.fontSize).toBe(9);
  });

  it("setFontSize clamps above maximum to 16", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.setFontSize(99));
    expect(result.current.prefs.fontSize).toBe(16);
  });

  it("stepFontSize increments within range", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.stepFontSize(2)); // 12 + 2 = 14
    expect(result.current.prefs.fontSize).toBe(14);
  });

  it("stepFontSize does not exceed max", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.stepFontSize(10)); // 12 + 10 = 22 → clamp to 16
    expect(result.current.prefs.fontSize).toBe(16);
  });

  it("stepFontSize does not go below min", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.stepFontSize(-10)); // 12 - 10 = 2 → clamp to 9
    expect(result.current.prefs.fontSize).toBe(9);
  });

  // ── THE DRAFT FIELD'S OWN SIZE ────────────────────────────────────────────────────────────────
  // Its own number, its own narrower range, and a floor the browser imposes rather than the app.

  it("defaults the draft field to 14, below the mirror-independent 16 the field used to be pinned at", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs.draftFontSize).toBe(14);
  });

  it("steps the draft size on its own, leaving the mirror's size untouched", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.stepDraftFontSize(1));
    expect(result.current.prefs.draftFontSize).toBe(15);
    expect(result.current.prefs.fontSize).toBe(12); // the two knobs are two settings
  });

  it("clamps the draft size to its own 13–16, not the mirror's 9–16", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.stepDraftFontSize(-10));
    expect(result.current.prefs.draftFontSize).toBe(DRAFT_FONT_MIN);
    act(() => result.current.stepDraftFontSize(+10));
    expect(result.current.prefs.draftFontSize).toBe(DRAFT_FONT_MAX);
  });

  it("persists the draft size and reloads it on mount", () => {
    const first = renderHook(() => useDisplayPrefs());
    act(() => first.result.current.stepDraftFontSize(-1));
    first.unmount();
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs.draftFontSize).toBe(13);
  });

  // The same independent-default rule every other field here keeps: an install that stored its prefs
  // before this existed must read 14 and keep everything else it chose.
  it("reads a pre-draftFontSize payload without discarding the prefs it does have", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ wrap: false, fontSize: 15, rawTerminal: true }));
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs.draftFontSize).toBe(14);
    expect(result.current.prefs.fontSize).toBe(15);
    expect(result.current.prefs.wrap).toBe(false);
  });

  it("clamps a stored draft size from outside the range", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ draftFontSize: 99 }));
    expect(renderHook(() => useDisplayPrefs()).result.current.prefs.draftFontSize).toBe(DRAFT_FONT_MAX);
  });
});

// The browser fact, isolated: mobile Safari zooms the viewport into a focused field whose font-size
// is under 16px and does not zoom back out when it blurs. jsdom reports no touch points, so the
// probe would only ever exercise one branch — which is exactly why the fact is a PARAMETER of the
// pure function and the probe is tested separately.
describe("applyDraftFontSize — the iOS zoom floor", () => {
  it("leaves the operator's number alone where a small field does not zoom the page", () => {
    expect(applyDraftFontSize(13, false)).toBe(13);
    expect(applyDraftFontSize(14, false)).toBe(14);
    expect(applyDraftFontSize(16, false)).toBe(16);
  });

  it("raises anything under 16 to 16 on iOS, and is a FLOOR — never a ceiling", () => {
    expect(applyDraftFontSize(13, true)).toBe(IOS_NO_ZOOM_FONT_PX);
    expect(applyDraftFontSize(15, true)).toBe(IOS_NO_ZOOM_FONT_PX);
    // 16 is inside the range, so the operator who asks for it gets exactly it, clamp or no clamp.
    expect(applyDraftFontSize(16, true)).toBe(16);
  });

  it("clamps a junk preference to the range before the floor is even considered", () => {
    expect(applyDraftFontSize(2, false)).toBe(DRAFT_FONT_MIN);
    expect(applyDraftFontSize(99, false)).toBe(DRAFT_FONT_MAX);
  });

  // Conservative in the direction that costs least: both halves are required. jsdom is neither an
  // Apple platform nor a touch device, so the default answer is "do not clamp".
  it("does not claim a plain jsdom page zooms", () => {
    expect(inputFocusZoomsPage()).toBe(false);
  });
});

describe("useDisplayPrefs — the rest", () => {
  beforeEach(() => localStorage.clear());

  it("falls back to defaults on malformed JSON", () => {
    localStorage.setItem(STORAGE_KEY, "not-json{{{");
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs).toEqual({ wrap: false, fontSize: 12, draftFontSize: 14, fontFamily: "system", terminalForeground: "", terminalBackground: "", rawTerminal: false, tapToFocus: true });
  });

  it("falls back to defaults when stored value is not an object", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(42));
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs).toEqual({ wrap: false, fontSize: 12, draftFontSize: 14, fontFamily: "system", terminalForeground: "", terminalBackground: "", rawTerminal: false, tapToFocus: true });
  });
});
