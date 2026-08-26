import { FormEvent, useMemo, useState } from "react";
import { FileSpreadsheet, Trash2, Upload } from "lucide-react";
import {
  columnWidthsForContent,
  DataGrid,
  EmptyGridRow,
  GridCell,
  GridRow,
} from "@/components/DataGrid";
import { ExcelSheetDialog } from "@/components/ExcelSheetDialog";
import { FileDropzone } from "@/components/FileDropzone";
import { AppDialog } from "@/components/AppDialog";
import { PageHeader, PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { MetaField } from "@/components/ui/meta-field";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { useFiles } from "@/hooks/useFiles";
import { useLanguage } from "@/i18n/LanguageProvider";
import { fmtBytes, fmtDelimiterGlyph } from "@/lib/format";
import { showConfirm, toastError } from "@/lib/notifications";
import { fileApi } from "@/services/fileApi";
import type {
  FilePreview,
  StagedWorkbook,
  StoredFile,
  WorkbookSheetSelection,
} from "@/types/file";

type QueuedFile = { id: string; file: File; name: string };
const FILE_ACCEPT = ".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function fileExtension(name: string): string {
  const at = name.lastIndexOf(".");
  return at >= 0 ? name.slice(at).toLowerCase() : "";
}

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function originalExt(name: string): string {
  const base = name.replace(/^.*[/\\]/, "");
  const index = base.lastIndexOf(".");
  return index > 0 ? base.slice(index) : "";
}

function saveAsName(original: string, requested: string): string {
  const trimmed = requested.trim() || original;
  const ext = originalExt(original);
  if (!ext) return trimmed;
  return originalExt(trimmed) ? trimmed : `${trimmed}${ext}`;
}

export function FilesPage() {
  const { messages } = useLanguage();
  const { files, refreshFiles } = useFiles();
  const [busy, setBusy] = useState(false);
  const [readingWorkbook, setReadingWorkbook] = useState(false);
  const [savingWorkbook, setSavingWorkbook] = useState(false);
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [storedSelected, setStoredSelected] = useState<string[]>([]);
  const [workbooks, setWorkbooks] = useState<StagedWorkbook[]>([]);
  const [previewing, setPreviewing] = useState<StoredFile | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const allSelected = queue.length > 0 && selected.length === queue.length;
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const storedSelectedSet = useMemo(() => new Set(storedSelected), [storedSelected]);
  const allStoredSelected = files.length > 0 && storedSelected.length === files.length;
  const previewWidths = useMemo(
    () => (preview ? columnWidthsForContent(preview.columns, preview.rows) : undefined),
    [preview],
  );

  function addCsvFiles(incoming: File[]) {
    setQueue((current) => {
      const seen = new Set(current.map((item) => fileKey(item.file)));
      const next = [...current];
      for (const file of incoming) {
        const key = fileKey(file);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push({ id: crypto.randomUUID(), file, name: file.name });
      }
      return next;
    });
  }

  async function addFiles(incoming: File[]) {
    const accepted = incoming.filter((file) =>
      [".csv", ".xls", ".xlsx"].includes(fileExtension(file.name)),
    );
    if (accepted.length !== incoming.length) {
      toastError(messages.errors.unsupportedUploadType);
    }

    addCsvFiles(accepted.filter((file) => fileExtension(file.name) === ".csv"));
    const excelFiles = accepted.filter((file) =>
      [".xls", ".xlsx"].includes(fileExtension(file.name)),
    );
    if (excelFiles.length === 0) return;

    setReadingWorkbook(true);
    try {
      for (const file of excelFiles) {
        const staged = await fileApi.stageWorkbook(file);
        setWorkbooks((current) => [...current, staged]);
      }
    } catch (err) {
      toastError(messages.errors.workbookRead, err);
    } finally {
      setReadingWorkbook(false);
    }
  }

  async function closeWorkbook() {
    const workbook = workbooks[0];
    if (!workbook || savingWorkbook) return;
    setWorkbooks((current) => current.slice(1));
    try {
      await fileApi.cancelWorkbook(workbook.staging_id);
    } catch {}
  }

  async function saveWorkbookSheets(
    sheets: WorkbookSheetSelection[],
    options: { delimiter: string; header: boolean; addSequence: boolean },
  ) {
    const workbook = workbooks[0];
    if (!workbook) return;
    setSavingWorkbook(true);
    try {
      await fileApi.commitWorkbook(workbook.staging_id, sheets, options);
      setWorkbooks((current) => current.slice(1));
      await refreshFiles();
    } catch (err) {
      toastError(messages.errors.workbookCommit, err);
    } finally {
      setSavingWorkbook(false);
    }
  }

  function toggleOne(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  function toggleAll() {
    setSelected(allSelected ? [] : queue.map((item) => item.id));
  }

  function removeSelected() {
    const removing = new Set(selected);
    setQueue((current) => current.filter((item) => !removing.has(item.id)));
    setSelected([]);
  }

  function toggleStoredOne(id: string) {
    setStoredSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  function toggleStoredAll() {
    setStoredSelected(allStoredSelected ? [] : files.map((file) => file.id));
  }

  async function deleteStored() {
    if (storedSelected.length === 0) return;
    const confirmed = await showConfirm(
      messages.files.deleteConfirmTitle,
      messages.files.deleteConfirmMessage(storedSelected.length),
      { tone: "danger" },
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      for (const id of storedSelected) {
        await fileApi.deleteFile(id);
      }
      if (previewing && storedSelectedSet.has(previewing.id)) {
        setPreviewing(null);
        setPreview(null);
      }
      setStoredSelected([]);
      await refreshFiles();
    } catch (err) {
      toastError(messages.errors.deleteFile, err);
      await refreshFiles();
    } finally {
      setBusy(false);
    }
  }

  async function openPreview(file: StoredFile) {
    setPreviewing(file);
    setPreview(null);
    setPreviewLoading(true);
    try {
      const next = await fileApi.previewFile(file.id);
      setPreview(next);
    } catch (err) {
      setPreviewing(null);
      toastError(messages.errors.filePreview, err);
    } finally {
      setPreviewLoading(false);
    }
  }

  function closePreview() {
    setPreviewing(null);
    setPreview(null);
    setPreviewLoading(false);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (queue.length === 0) return;

    setBusy(true);
    try {
      for (const item of queue) {
        await fileApi.uploadFile(item.file, saveAsName(item.file.name, item.name));
        setQueue((current) => current.filter((queued) => queued.id !== item.id));
        setSelected((current) => current.filter((id) => id !== item.id));
      }
      await refreshFiles();
    } catch (err) {
      toastError(messages.errors.upload, err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell>
      <PageHeader
        iconName="files"
        eyebrow={messages.files.eyebrow}
        title={messages.files.title}
        description={messages.files.description}
      />

      <Panel>
        <PanelHeader title={messages.files.uploadTitle} description={messages.files.uploadDescription} />
        <PanelBody>
          <form className="flex flex-col gap-3" onSubmit={(event) => void onSubmit(event)}>
            <FileDropzone
              accept={FILE_ACCEPT}
              disabled={busy || readingWorkbook}
              onFiles={(files) => void addFiles(files)}
            />
            <p className="text-center text-[11px] text-text-tertiary">
              {readingWorkbook
                ? messages.files.readingWorkbook
                : messages.files.acceptedFormats}
            </p>

            {queue.length > 0 ? (
              <div className="overflow-hidden rounded-lg border border-border">
                <div className="flex items-center justify-between gap-3 border-b border-border bg-subtle px-3 py-1.5">
                  <label className="flex min-w-0 items-center gap-2 text-xs font-medium text-text">
                    <input
                      className="field-control"
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      aria-label={messages.files.selectAll}
                    />
                    <span>
                      {messages.files.queued}
                      <span className="ml-1.5 font-normal text-text-tertiary">
                        {messages.common.count(queue.length)}
                      </span>
                    </span>
                  </label>
                  <Button
                    type="button"
                    variant="danger"
                    disabled={selected.length === 0 || busy}
                    onClick={removeSelected}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                    {messages.files.removeSelected}
                  </Button>
                </div>
                <ul className="max-h-48 overflow-auto">
                  {queue.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
                    >
                      <input
                        className="field-control shrink-0"
                        type="checkbox"
                        checked={selectedSet.has(item.id)}
                        onChange={() => toggleOne(item.id)}
                        aria-label={item.file.name}
                      />
                      <input
                        className="field-control min-w-0 flex-1"
                        value={item.name}
                        disabled={busy}
                        autoComplete="off"
                        spellCheck={false}
                        title={item.file.name}
                        aria-label={messages.files.saveAs}
                        onChange={(event) => {
                          const name = event.target.value;
                          setQueue((current) =>
                            current.map((queued) => (queued.id === item.id ? { ...queued, name } : queued)),
                          );
                        }}
                      />
                      <span className="technical shrink-0 text-text-tertiary">{fmtBytes(item.file.size)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="flex justify-center">
              <Button variant="primary" type="submit" disabled={busy || queue.length === 0}>
                <Upload className="size-3.5" aria-hidden="true" />
                {busy ? messages.files.uploading : messages.files.upload}
              </Button>
            </div>
          </form>
        </PanelBody>
      </Panel>

      <Panel tall>
        <Toolbar>
          <ToolbarGroup>
            <label className="flex items-center gap-2 text-[13px] font-semibold text-text">
              <input
                className="field-control"
                type="checkbox"
                checked={allStoredSelected}
                disabled={files.length === 0 || busy}
                onChange={toggleStoredAll}
                aria-label={messages.files.selectAll}
              />
              <span>{messages.files.stored}</span>
            </label>
            <span className="text-xs text-text-tertiary">{messages.common.count(files.length)}</span>
          </ToolbarGroup>
          <ToolbarGroup>
            <Button
              type="button"
              variant="danger"
              disabled={storedSelected.length === 0 || busy}
              onClick={() => void deleteStored()}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {messages.files.deleteStored}
            </Button>
          </ToolbarGroup>
        </Toolbar>
        <DataGrid
          className="min-h-0 flex-1"
          headers={[...messages.files.headers]}
          columnWidths={[80, 220, 120, 140, 280]}
        >
          {files.length === 0 ? (
            <EmptyGridRow cols={5} text={messages.empty.uploads} />
          ) : (
            files.map((file) => (
              <GridRow
                key={`${file.id}-${file.filename}`}
                selected={storedSelectedSet.has(file.id)}
                onClick={() => void openPreview(file)}
              >
                <GridCell>
                  <input
                    className="field-control"
                    type="checkbox"
                    checked={storedSelectedSet.has(file.id)}
                    disabled={busy}
                    aria-label={file.filename}
                    onChange={() => toggleStoredOne(file.id)}
                    onClick={(event) => event.stopPropagation()}
                  />
                </GridCell>
                <GridCell>{file.filename}</GridCell>
                <GridCell mono>{fmtBytes(file.size)}</GridCell>
                <GridCell mono muted>{file.id.slice(0, 8)}</GridCell>
                <GridCell mono muted>{file.stored_path}</GridCell>
              </GridRow>
            ))
          )}
        </DataGrid>
      </Panel>

      <ExcelSheetDialog
        workbook={workbooks[0] ?? null}
        saving={savingWorkbook}
        onClose={() => void closeWorkbook()}
        onSave={(sheets, options) => void saveWorkbookSheets(sheets, options)}
      />

      <AppDialog
        open={Boolean(previewing)}
        title={previewing?.filename ?? messages.files.previewTitle}
        icon={<FileSpreadsheet className="size-4 text-accent" aria-hidden="true" />}
        className="h-[min(42rem,88vh)] w-[min(72rem,94vw)]"
        minWidth={520}
        minHeight={360}
        onClose={closePreview}
        footer={
          <Button type="button" variant="secondary" onClick={closePreview}>
            {messages.common.close}
          </Button>
        }
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {preview ? (
            <div className="flex min-w-0 shrink-0 flex-wrap items-start gap-5 border-b border-border px-4 py-2.5">
              <MetaField label={messages.files.previewRows} technical>
                {messages.common.rows(preview.rows.length)}
              </MetaField>
              <MetaField label={messages.files.totalRows} technical>
                {messages.common.rows(preview.row_count)}
              </MetaField>
              <MetaField label={messages.common.delimiter} technical>
                {fmtDelimiterGlyph(preview.delimiter, messages)}
              </MetaField>
              {preview.columns.length > 0 ? (
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-medium leading-none text-text-tertiary">
                    {messages.common.columns}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {preview.columns.map((column, index) => (
                      <span
                        key={`${index}-${column}`}
                        title={column}
                        className="max-w-full truncate rounded-full border border-border bg-raised px-2 py-0.5 text-[11px] font-medium text-text"
                      >
                        {column}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden p-4">
            {previewLoading || !preview ? (
              <div className="grid h-full min-h-64 place-items-center text-sm text-text-tertiary">
                {previewLoading ? messages.files.previewLoading : messages.files.previewEmpty}
              </div>
            ) : (
              <DataGrid
                className="h-full min-h-64"
                headers={preview.columns}
                columnWidths={previewWidths}
              >
                {preview.rows.length === 0 ? (
                  <EmptyGridRow cols={preview.columns.length} text={messages.files.previewEmpty} />
                ) : (
                  preview.rows.map((row, index) => (
                    <GridRow key={index}>
                      {preview.columns.map((_, cellIndex) => (
                        <GridCell key={cellIndex} mono title={row[cellIndex] ?? ""}>
                          {row[cellIndex] ?? ""}
                        </GridCell>
                      ))}
                    </GridRow>
                  ))
                )}
              </DataGrid>
            )}
          </div>
        </div>
      </AppDialog>
    </PageShell>
  );
}
