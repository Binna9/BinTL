import { useEffect, useState, type CSSProperties } from "react";
import { StickyNote } from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { Button } from "@/components/ui/button";
import type { Messages } from "@/i18n/ko";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { toastError, toastSuccess } from "@/lib/notifications";
import { chipApi } from "@/services/chips/chipApi";
import { isDraftChipId, type Chip } from "@/types/chip";

export const MAX_MEMO_TEXT = 64 * 1024;
export const MEMO_FONT_SIZES = [14, 16, 18, 20, 24] as const;
export const DEFAULT_MEMO_FONT_SIZE = 16;

export type MemoStyle = {
  text: string;
  font_size: number;
  bold: boolean;
  underline: boolean;
};

export function memoFontSize(value: unknown): number {
  return typeof value === "number" && (MEMO_FONT_SIZES as readonly number[]).includes(value)
    ? value
    : DEFAULT_MEMO_FONT_SIZE;
}

export function memoText(chip: Chip | null | undefined): string {
  return typeof chip?.config.text === "string" ? chip.config.text : "";
}

export function memoStyle(chip: Chip | null | undefined): MemoStyle {
  return {
    text: memoText(chip),
    font_size: memoFontSize(chip?.config.font_size),
    bold: chip?.config.bold === true,
    underline: chip?.config.underline === true,
  };
}

export function memoConfig(chip: Chip | null | undefined, patch: Partial<MemoStyle> = {}): MemoStyle {
  return { ...memoStyle(chip), ...patch };
}

export function memoTextCss(style: Pick<MemoStyle, "font_size" | "bold" | "underline">): CSSProperties {
  return {
    "--memo-font-size": `${style.font_size}px`,
    fontSize: style.font_size,
    fontWeight: style.bold ? 700 : 400,
    textDecoration: style.underline ? "underline" : "none",
  } as CSSProperties;
}

export function MemoFormatBar({
  style,
  disabled,
  messages,
  onChange,
}: {
  style: MemoStyle;
  disabled?: boolean;
  messages: Messages;
  onChange: (patch: Partial<MemoStyle>) => void;
}) {
  return (
    <div
      className="workspace-memo-format"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <label className="workspace-memo-format-size">
        <span className="sr-only">{messages.workspace.memoFontSize}</span>
        <select
          value={style.font_size}
          disabled={disabled}
          aria-label={messages.workspace.memoFontSize}
          title={messages.workspace.memoFontSize}
          onChange={(event) => onChange({ font_size: Number(event.target.value) })}
        >
          {MEMO_FONT_SIZES.map((size) => (
            <option key={size} value={size}>{size}</option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className={cn(style.bold && "is-on")}
        disabled={disabled}
        aria-pressed={style.bold}
        aria-label={messages.workspace.memoBold}
        title={messages.workspace.memoBold}
        onClick={() => onChange({ bold: !style.bold })}
      >
        <span className="font-bold">B</span>
      </button>
      <button
        type="button"
        className={cn(style.underline && "is-on")}
        disabled={disabled}
        aria-pressed={style.underline}
        aria-label={messages.workspace.memoUnderline}
        title={messages.workspace.memoUnderline}
        onClick={() => onChange({ underline: !style.underline })}
      >
        <span className="underline">U</span>
      </button>
    </div>
  );
}

export function MemoChipEditorDialog({
  open,
  chip,
  onClose,
  onSaved,
}: {
  open: boolean;
  chip: Chip | null;
  onClose: () => void;
  onSaved: (chip: Chip) => void;
}) {
  const { messages } = useLanguage();
  const [style, setStyle] = useState<MemoStyle>(memoStyle(chip));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStyle(memoStyle(chip));
    setBusy(false);
  }, [chip, open]);

  const tooLong = style.text.length > MAX_MEMO_TEXT;
  const canSave = Boolean(chip) && !busy && !tooLong;

  async function save() {
    if (!chip || !canSave) return;
    if (tooLong) {
      toastError(messages.workspace.memoTooLong);
      return;
    }
    const next = { ...chip, config: style };
    if (isDraftChipId(chip.id)) {
      toastSuccess(messages.workspace.memoSaved);
      onSaved(next);
      return;
    }
    setBusy(true);
    try {
      const saved = await chipApi.update(chip.id, { config: style });
      toastSuccess(messages.workspace.memoSaved);
      onSaved(saved);
    } catch (error) {
      toastError(messages.workspace.saveChipError, error);
      setBusy(false);
    }
  }

  return (
    <AppDialog
      open={open}
      title={chip?.name || messages.workspace.memo}
      icon={<StickyNote className="size-4 text-rose-600 dark:text-rose-400" aria-hidden="true" />}
      className="h-[min(28rem,88vh)] w-[min(28rem,92vw)]"
      minWidth={320}
      minHeight={320}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="quiet" onClick={onClose}>
            {messages.common.cancel}
          </Button>
          <Button type="button" variant="primary" disabled={!canSave} onClick={() => void save()}>
            {messages.common.save}
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col p-3">
        <MemoFormatBar
          style={style}
          disabled={busy}
          messages={messages}
          onChange={(patch) => setStyle((current) => ({ ...current, ...patch }))}
        />
        <label className="mt-2 flex min-h-0 min-w-0 flex-1 flex-col">
          <span className="sr-only">{messages.workspace.memo}</span>
          <textarea
            className="min-h-0 flex-1 resize-none rounded-xl border border-border bg-subtle/40 p-3 text-text outline-none placeholder:text-text-tertiary focus:border-accent focus:ring-2 focus:ring-accent/15"
            style={memoTextCss(style)}
            value={style.text}
            placeholder={messages.workspace.memoPlaceholder}
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setStyle((current) => ({ ...current, text: event.target.value }))}
          />
        </label>
      </div>
    </AppDialog>
  );
}

if (import.meta.env.DEV) {
  console.assert(memoFontSize(18) === 18, "memo: keep allowed font size");
  console.assert(memoFontSize(99) === DEFAULT_MEMO_FONT_SIZE, "memo: clamp unknown font size");
  console.assert(memoStyle({ config: { bold: true, underline: 1 } } as unknown as Chip).underline === false, "memo: underline must be boolean");
}
