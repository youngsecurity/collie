import { ClipboardPaste } from "lucide-react";

import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

// THE HELD PASTE (issue #134). Type mode does not send a field value that carries a line break:
// sent as keys, each break is an Enter, and Enter submits in an agent's answer editor, so the first
// line would go out as the whole answer and the rest would land in whatever has the keyboard next.
// The text waits in the field and this strip offers the only ways out, each one named.
//
// "Line by line" is the old behaviour, on purpose and on request. It is offered for a shell only,
// where a line break is how several commands are run; an agent pane never gets it.
export function HeldPasteStrip({
  allowLineByLine,
  onOneLine,
  onLineByLine,
  onDiscard,
}: {
  allowLineByLine: boolean;
  onOneLine: () => void;
  onLineByLine: () => void;
  onDiscard: () => void;
}) {
  useLocale();
  const button =
    "shrink-0 rounded-md px-2 py-0.5 font-medium underline-offset-2 transition-colors hover:underline active:bg-muted";
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive">
      <ClipboardPaste className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{t("directTyping.heldPaste.title")}</span>
      <button type="button" onClick={onOneLine} className={button}>
        {t("directTyping.heldPaste.oneLine")}
      </button>
      {allowLineByLine && (
        <button type="button" onClick={onLineByLine} className={button}>
          {t("directTyping.heldPaste.lineByLine")}
        </button>
      )}
      <button type="button" onClick={onDiscard} className={button}>
        {t("directTyping.heldPaste.discard")}
      </button>
    </div>
  );
}
