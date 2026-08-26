import { useEffect, useMemo, useState } from "react";
import { FileSpreadsheet, Save } from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Select } from "@/components/ui/select";
import { useLanguage } from "@/i18n/LanguageProvider";
import { DELIMITER_VALUES, isValidDelimiter } from "@/lib/delimiter";
import { toastError } from "@/lib/notifications";
import type {
  StagedWorkbook,
  WorkbookSheetSelection,
} from "@/types/file";

function safePart(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[. ]+$/g, "") || "sheet";
}

function workbookBase(filename: string): string {
  return safePart(filename.replace(/\.(xlsx?|xls)$/i, ""));
}

export function ExcelSheetDialog({
  workbook,
  saving,
  onClose,
  onSave,
}: {
  workbook: StagedWorkbook | null;
  saving: boolean;
  onClose: () => void;
  onSave: (
    sheets: WorkbookSheetSelection[],
    options: { delimiter: string; header: boolean; addSequence: boolean },
  ) => void;
}) {
  const { messages } = useLanguage();
  const [selected, setSelected] = useState<string[]>([]);
  const [filenames, setFilenames] = useState<Record<string, string>>({});
  const [delimiter, setDelimiter] = useState(",");
  const [header, setHeader] = useState(true);
  const [addSequence, setAddSequence] = useState(false);
  const delimiterOptions = useMemo(
    () =>
      DELIMITER_VALUES.map((value) => ({
        value,
        label: value === " " ? messages.format.space : value === "tab" ? "tab" : value,
      })),
    [messages],
  );

  useEffect(() => {
    if (!workbook) return;
    const base = workbookBase(workbook.original_filename);
    setSelected(workbook.sheets.map((sheet) => sheet.name));
    setFilenames(
      Object.fromEntries(
        workbook.sheets.map((sheet) => [
          sheet.name,
          `${base}_${safePart(sheet.name)}.csv`,
        ]),
      ),
    );
    setDelimiter(",");
    setHeader(true);
    setAddSequence(false);
  }, [workbook]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const allSelected = Boolean(
    workbook?.sheets.length && selected.length === workbook.sheets.length,
  );

  function submit() {
    if (!workbook || selected.length === 0) {
      toastError(messages.files.noSheetsSelected);
      return;
    }
    if (!isValidDelimiter(delimiter)) {
      toastError(messages.files.invalidDelimiter);
      return;
    }
    onSave(
      workbook.sheets
        .filter((sheet) => selectedSet.has(sheet.name))
        .map((sheet) => ({
          name: sheet.name,
          filename: filenames[sheet.name]?.trim() || `${safePart(sheet.name)}.csv`,
        })),
      {
        delimiter: delimiter.trim() || delimiter,
        header,
        addSequence,
      },
    );
  }

  return (
    <AppDialog
      open={Boolean(workbook)}
      title={messages.files.sheetDialogTitle}
      icon={<FileSpreadsheet className="size-4 text-accent" aria-hidden="true" />}
      className="h-[min(38rem,88vh)] w-[min(42rem,94vw)]"
      minWidth={420}
      minHeight={320}
      onClose={() => {
        if (!saving) onClose();
      }}
      footer={
        <>
          <Button type="button" variant="secondary" disabled={saving} onClick={onClose}>
            {messages.common.close}
          </Button>
          <Button type="button" variant="primary" disabled={saving} onClick={submit}>
            <Save className="size-3.5" aria-hidden="true" />
            {saving ? messages.common.saving : messages.files.saveSheets}
          </Button>
        </>
      }
    >
      {workbook ? (
        <div className="flex min-h-0 flex-1 flex-col p-4">
          <p className="text-xs leading-5 text-text-secondary">
            {messages.files.sheetDialogDescription}
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="w-48" title={messages.connectionsPage.delimiterTitle}>
              <FormField label={messages.common.delimiter}>
                <Select
                  editable
                  className="technical"
                  value={delimiter}
                  disabled={saving}
                  options={delimiterOptions}
                  onChange={setDelimiter}
                />
              </FormField>
            </div>
            <label className="mb-1 flex shrink-0 items-center gap-2 whitespace-nowrap text-xs font-medium text-text">
              <input
                className="field-control"
                type="checkbox"
                checked={header}
                disabled={saving}
                onChange={(event) => setHeader(event.target.checked)}
              />
              {messages.common.header}
            </label>
            <label className="mb-1 flex shrink-0 items-center gap-2 whitespace-nowrap text-xs font-medium text-text">
              <input
                className="field-control"
                type="checkbox"
                checked={addSequence}
                disabled={saving}
                onChange={(event) => setAddSequence(event.target.checked)}
              />
              {messages.common.addSequence}
            </label>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-subtle px-3 py-2">
            <label className="flex items-center gap-2 text-xs font-medium text-text">
              <input
                className="field-control"
                type="checkbox"
                checked={allSelected}
                onChange={() =>
                  setSelected(
                    allSelected ? [] : workbook.sheets.map((sheet) => sheet.name),
                  )
                }
              />
              {messages.files.selectAllSheets}
            </label>
            <span className="technical text-[11px] text-text-tertiary">
              {messages.files.selectedSheets(selected.length)}
            </span>
          </div>
          <ul className="mt-3 min-h-0 flex-1 overflow-auto rounded-lg border border-border">
            {workbook.sheets.map((sheet) => {
              const checked = selectedSet.has(sheet.name);
              return (
                <li
                  key={`${sheet.index}-${sheet.name}`}
                  className="grid grid-cols-[auto_minmax(8rem,0.8fr)_minmax(12rem,1.2fr)] items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
                >
                  <input
                    className="field-control"
                    type="checkbox"
                    checked={checked}
                    aria-label={sheet.name}
                    onChange={() =>
                      setSelected((current) =>
                        current.includes(sheet.name)
                          ? current.filter((name) => name !== sheet.name)
                          : [...current, sheet.name],
                      )
                    }
                  />
                  <span className="truncate text-xs text-text" title={sheet.name}>
                    {sheet.name}
                  </span>
                  <input
                    className="field-control min-w-0"
                    value={filenames[sheet.name] ?? ""}
                    disabled={!checked || saving}
                    aria-label={`${sheet.name} ${messages.files.saveAs}`}
                    onChange={(event) =>
                      setFilenames((current) => ({
                        ...current,
                        [sheet.name]: event.target.value,
                      }))
                    }
                  />
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </AppDialog>
  );
}
