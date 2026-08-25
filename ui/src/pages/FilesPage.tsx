import { FormEvent, useMemo, useState } from "react";
import { Trash2, Upload } from "lucide-react";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { ExcelSheetDialog } from "@/components/ExcelSheetDialog";
import { FileDropzone } from "@/components/FileDropzone";
import { PageHeader, PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { NoticeBanner } from "@/components/ui/notice-banner";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { useFiles } from "@/hooks/useFiles";
import { useLanguage } from "@/i18n/LanguageProvider";
import { fmtBytes } from "@/lib/format";
import { fileApi } from "@/services/fileApi";
import type {
  StagedWorkbook,
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
  const { files, filesError, setFilesError, refreshFiles } = useFiles();
  const [busy, setBusy] = useState(false);
  const [readingWorkbook, setReadingWorkbook] = useState(false);
  const [savingWorkbook, setSavingWorkbook] = useState(false);
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [workbooks, setWorkbooks] = useState<StagedWorkbook[]>([]);

  const allSelected = queue.length > 0 && selected.length === queue.length;
  const selectedSet = useMemo(() => new Set(selected), [selected]);

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
    setFilesError("");
    const accepted = incoming.filter((file) =>
      [".csv", ".xls", ".xlsx"].includes(fileExtension(file.name)),
    );
    if (accepted.length !== incoming.length) {
      setFilesError(messages.errors.unsupportedUploadType);
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
      setFilesError(
        err instanceof Error ? err.message : messages.errors.workbookRead,
      );
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

  async function saveWorkbookSheets(sheets: WorkbookSheetSelection[], delimiter: string) {
    const workbook = workbooks[0];
    if (!workbook) return;
    setSavingWorkbook(true);
    setFilesError("");
    try {
      await fileApi.commitWorkbook(workbook.staging_id, sheets, delimiter);
      setWorkbooks((current) => current.slice(1));
      await refreshFiles();
    } catch (err) {
      setFilesError(
        err instanceof Error ? err.message : messages.errors.workbookCommit,
      );
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

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (queue.length === 0) return;

    setBusy(true);
    setFilesError("");
    try {
      for (const item of queue) {
        await fileApi.uploadFile(item.file, saveAsName(item.file.name, item.name));
        setQueue((current) => current.filter((queued) => queued.id !== item.id));
        setSelected((current) => current.filter((id) => id !== item.id));
      }
      await refreshFiles();
    } catch (err) {
      setFilesError(err instanceof Error ? err.message : messages.errors.upload);
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
      {filesError ? <NoticeBanner>{filesError}</NoticeBanner> : null}

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
            <span className="text-[13px] font-semibold">{messages.files.stored}</span>
            <span className="text-xs text-text-tertiary">{messages.common.count(files.length)}</span>
          </ToolbarGroup>
        </Toolbar>
        <DataGrid className="min-h-0 flex-1" headers={[...messages.files.headers]}>
          {files.length === 0 ? (
            <EmptyGridRow cols={4} text={messages.empty.uploads} />
          ) : (
            files.map((file) => (
              <GridRow key={`${file.id}-${file.filename}`}>
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
        onSave={(sheets, delimiter) => void saveWorkbookSheets(sheets, delimiter)}
      />
    </PageShell>
  );
}
