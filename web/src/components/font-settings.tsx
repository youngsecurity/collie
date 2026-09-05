import { AArrowDown, AArrowUp, ChevronDown, Type } from "lucide-react";
import type { ChangeEvent } from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MIRROR_INVERT, MIRROR_SPACE } from "@/components/mirror-space";
import {
  DRAFT_FONT_MAX,
  DRAFT_FONT_MIN,
  FONT_FAMILIES,
  FONT_MAX,
  FONT_MIN,
  isFontFamily,
  MATRIX_TERMINAL_COLORS,
  mirrorSurface,
  useDisplayPrefs,
  type FontFamily,
} from "@/hooks/use-display-prefs";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// The Terminal font card. It configures the mirror's face and size, and the composer draft field's
// size — the two surfaces that render terminal-bound text in the terminal face. Not the app's own
// typeface (see below), and nothing else.
//
// THE DRAFT HAS ITS OWN SIZE ROW rather than following the mirror's number, because the two are read
// differently: the mirror is output you scan and wants to be dense, the draft is a sentence you are
// writing and re-reading and wants to be comfortable. One knob would make every choice a compromise.
//
// THE APP'S OWN TYPEFACE IS NOT HERE, and that is still true — but for the opposite reason it used
// to be. This comment said the app face was "the maker's choice" with no setting and no hook
// (round-4 F-D1). That decision fell in round 5: it is a per-device preference now, and it has its
// own card, <TypefaceControl/>, mounted directly ABOVE this one (ADR 0033). So don't add a second
// control for it here — the two faces are two settings because they are two questions, and merging
// them would put the app's own voice behind a heading that says "Terminal".
//
// Shape follows the cards already in Settings rather than inventing a third one: the
// icon/title/description header every row here shares, then the controls in their own band under a
// `border-border` divider (ThemeControl), with the family on a native <select> for exactly the reason
// LanguageControl gives — seven stacked 44px radios would make this the tallest card on the page for
// a set-once preference, and the platform's own picker is better than one we could draw.
//
// The family names are PROPER NOUNS and are not translated; only "System default" is a phrase, and
// only it has a message key. A font is named the same in every locale.
//
// THE COLOURS ROW IS THE YOUNG SECURITY FORK'S, and it is on this card and not in the composer's
// Display sheet on purpose: it is a set-once, per-device choice about how the mirror reads, the same
// kind of question as the family above it, and the Display sheet is for the toggles you flip while
// reading a pane. Two native colour pickers (the platform's own, for the reason the family is a
// native <select>), one preset and one reset. The pickers show the mirror's own dark-space values
// while nothing is set, so opening one starts from what the pane actually renders, and the sample
// below repaints live because it wears the same mirrorSurface() pair the pane does.

/** What an unset side shows in its picker: the mirror's own value (MIRROR_SPACE's literals). */
const MIRROR_DEFAULT_FOREGROUND = "#fafafa";
const MIRROR_DEFAULT_BACKGROUND = "#0a0a0a";

const FAMILY_LABELS = {
  jetbrains: "JetBrains Mono",
  cascadia: "Cascadia Mono",
  menlo: "Menlo / SF Mono",
  roboto: "Roboto Mono",
  dejavu: "DejaVu Sans Mono",
  courier: "Courier New",
  meslo: "MesloLGS NF",
} satisfies Record<Exclude<FontFamily, "system">, string>;

// A line with the shapes a monospace face is actually judged on: a shell prompt, the digit/letter
// pairs that collide in a bad one (0/O, 1/l/I), a box-drawing run, and a Powerline separator from
// the bundled Nerd Font subset. If the separator renders as tofu, the leading "Nerd Font Symbols"
// entry has been lost from the stack — which is the one way this control can break the mirror.
const SAMPLE = "~/collie  0O1lI │ ok";

/** Settings card: the terminal mirror's font family and size. Device-local, like every display pref. */
export function FontSettingsControl() {
  useLocale();
  const { prefs, setFontFamily, setTerminalColors, stepFontSize, stepDraftFontSize } =
    useDisplayPrefs();

  const colorsSet = prefs.terminalForeground !== "" || prefs.terminalBackground !== "";
  const onForeground = (event: ChangeEvent<HTMLInputElement>) =>
    setTerminalColors({ foreground: event.target.value, background: prefs.terminalBackground });
  const onBackground = (event: ChangeEvent<HTMLInputElement>) =>
    setTerminalColors({ foreground: prefs.terminalForeground, background: event.target.value });
  // The preset is the face AND the colours: green on black was tuned against Meslo, and a phone
  // that asks for "Matrix" is asking for the whole look, not two thirds of it.
  const applyMatrix = () => {
    setFontFamily("meslo");
    setTerminalColors(MATRIX_TERMINAL_COLORS);
  };
  const resetColors = () => setTerminalColors({ foreground: "", background: "" });

  // Font AND colours (fork): the sample is one line of the mirror, so it wears what the mirror wears.
  const sampleFace = mirrorSurface(prefs);

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Type className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.fonts.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.fonts.description")}</p>
          </div>
        </div>
      </div>

      <div className="divide-y divide-border border-t border-border">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <label htmlFor="pref-font-family" className="text-sm font-medium">
            {t("settings.fonts.family")}
          </label>
          {/* Same construction as LanguageControl's select, for the same reasons: the wrapper owns
              the border and the chevron, `appearance-none` removes the engine's own caret, and the
              box is `shrink-0` so a long family name never resizes the row. */}
          <div className="relative shrink-0">
            <select
              id="pref-font-family"
              value={prefs.fontFamily}
              // A DOM value is a plain string whatever the options say, so it is parsed back at this
              // boundary rather than asserted. An unknown value is ignored — the same thing
              // loadPrefs does with a stale stored key.
              onChange={(event) => {
                const next = event.target.value;
                if (isFontFamily(next)) setFontFamily(next);
              }}
              className="min-h-11 appearance-none rounded-md border border-border/60 bg-background py-2 pl-3 pr-9 text-sm font-medium text-foreground"
            >
              {FONT_FAMILIES.map((family) => (
                <option key={family} value={family}>
                  {family === "system" ? t("settings.fonts.system") : FAMILY_LABELS[family]}
                </option>
              ))}
            </select>
            <ChevronDown
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="text-sm font-medium">{t("settings.fonts.size")}</div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="size-11"
              disabled={prefs.fontSize <= FONT_MIN}
              onClick={() => stepFontSize(-1)}
              aria-label={t("settings.display.textSize.decrease")}
            >
              <AArrowDown className="size-4" />
            </Button>
            {/* Fixed width + tabular figures: the number must not resize its own slot as it steps,
                or the two buttons beside it walk. */}
            <span className="w-8 text-center text-xs tabular-nums text-muted-foreground">
              {prefs.fontSize}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="size-11"
              disabled={prefs.fontSize >= FONT_MAX}
              onClick={() => stepFontSize(1)}
              aria-label={t("settings.display.textSize.increase")}
            >
              <AArrowUp className="size-4" />
            </Button>
          </div>
        </div>

        {/* THE SECOND SIZE ROW: the composer's draft field, which is not the mirror.
            Same stepper grammar as the row above — 44px buttons, a fixed tabular slot so the number
            cannot resize its own box as it steps (§2), each end disabled at its own limit — because
            it is the same question asked of a second surface, and a second shape would say the two
            were different kinds of setting.
            IT CARRIES A HINT AND THE ROW ABOVE DOES NOT, for a reason the operator will otherwise
            discover by tapping: on iOS the lower half of this range does nothing. `applyDraftFontSize`
            raises anything under 16px there, because Safari zooms the page into a smaller focused
            field and never zooms back out. A stepper that silently ignores three of its four values
            is worse than one that says so. */}
        <div className="flex items-start justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">{t("settings.fonts.draftSize")}</div>
            <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
              {t("settings.fonts.draftSize.hint")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="size-11"
              disabled={prefs.draftFontSize <= DRAFT_FONT_MIN}
              onClick={() => stepDraftFontSize(-1)}
              aria-label={t("settings.fonts.draftSize.decrease")}
            >
              <AArrowDown className="size-4" />
            </Button>
            <span className="w-8 text-center text-xs tabular-nums text-muted-foreground">
              {prefs.draftFontSize}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="size-11"
              disabled={prefs.draftFontSize >= DRAFT_FONT_MAX}
              onClick={() => stepDraftFontSize(1)}
              aria-label={t("settings.fonts.draftSize.increase")}
            >
              <AArrowUp className="size-4" />
            </Button>
          </div>
        </div>

        {/* THE COLOURS ROW (fork). Two 44px swatches, each a native <input type="color"> inside a
            bordered box the same size as the steppers' buttons, so the row reads as the same grammar
            as the two above it. The swatch's value is what the pane renders right now: the chosen
            colour, or the mirror's own dark-space value when nothing is chosen. */}
        <div className="flex items-start justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">{t("settings.fonts.colors")}</div>
            <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
              {t("settings.fonts.colors.hint")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <label
              className="flex size-11 cursor-pointer items-center justify-center rounded-md border border-border/60 bg-background"
              title={t("settings.fonts.colors.foreground")}
            >
              <input
                type="color"
                aria-label={t("settings.fonts.colors.foreground")}
                value={prefs.terminalForeground === "" ? MIRROR_DEFAULT_FOREGROUND : prefs.terminalForeground}
                onChange={onForeground}
                className="size-6 cursor-pointer rounded border-0 bg-transparent p-0"
              />
            </label>
            <label
              className="flex size-11 cursor-pointer items-center justify-center rounded-md border border-border/60 bg-background"
              title={t("settings.fonts.colors.background")}
            >
              <input
                type="color"
                aria-label={t("settings.fonts.colors.background")}
                value={prefs.terminalBackground === "" ? MIRROR_DEFAULT_BACKGROUND : prefs.terminalBackground}
                onChange={onBackground}
                className="size-6 cursor-pointer rounded border-0 bg-transparent p-0"
              />
            </label>
          </div>
        </div>

        {/* Preset and reset, on their own row so the swatches above never have to shrink to make
            room for two words on a narrow phone. Reset is disabled, not hidden, while there is
            nothing to reset (§2: a row's controls do not come and go). */}
        <div className="flex items-start justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">{t("settings.fonts.colors.matrix")}</div>
            <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
              {t("settings.fonts.colors.matrix.hint")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="outline" className="min-h-11" onClick={applyMatrix}>
              {t("settings.fonts.colors.matrix")}
            </Button>
            <Button variant="outline" className="min-h-11" disabled={!colorsSet} onClick={resetColors}>
              {t("settings.fonts.colors.reset")}
            </Button>
          </div>
        </div>

        {/* The proof. Settings does not show the mirror, so the card shows one line OF the mirror —
            in the mirror's own dark space, inverted in light with it (ADR 0002), or in the colours
            chosen above, absolute in both themes (fork), so what you read here is what the pane
            will render.
            NO LAYOUT SHIFT: the row's height is pinned by `leading-none` on a fixed 16px line box,
            not by the chosen face's own metrics, and the text is `whitespace-pre overflow-hidden`,
            so a wider face runs off the edge instead of wrapping the card taller. */}
        <div
          aria-hidden="true"
          className={cn(
            "h-12 overflow-hidden px-4 py-4 leading-none",
            MIRROR_SPACE,
            sampleFace.colors === undefined && MIRROR_INVERT,
            sampleFace.className,
          )}
          style={sampleFace.style}
        >
          <div
            className="overflow-hidden whitespace-pre font-mono"
            style={{ fontSize: `${prefs.fontSize}px`, lineHeight: "16px" }}
          >
            {SAMPLE}
          </div>
        </div>
      </div>
    </Card>
  );
}
