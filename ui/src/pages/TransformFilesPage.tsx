import { useEffect, useMemo, useState } from "react";
import { FileSpreadsheet, Trash2 } from "lucide-react";
import {
  columnWidthsForContent,
  DataGrid,
  EmptyGridRow,
  GridCell,
  GridRow,
} from "@/components/DataGrid";
import { AppDialog } from "@/components/AppDialog";
import { PageHeader, PageShell } from "@/components/PageShell";
import { ActionAnchor, Button } from "@/components/ui/button";
import { MetaField } from "@/components/ui/meta-field";
import { Panel } from "@/components/ui/panel";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { useLanguage } from "@/i18n/LanguageProvider";
import { fmtBytes, fmtWhen } from "@/lib/format";
import { showConfirm, toastDeleteError, toastError } from "@/lib/notifications";
import { datasetApi } from "@/services/datasetApi";
import type { Dataset, FramePreview } from "@/types/dataset";

export function TransformFilesPage() {
  const { messages } = useLanguage();
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState<Dataset | null>(null);
  const [preview, setPreview] = useState<FramePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const files = useMemo(
    () => datasets.filter((item) => item.kind === "transform"),
    [datasets],
  );
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const allSelected = files.length > 0 && selected.length === files.length;
  const previewHeaders = preview?.columns.map((column) => column.name) ?? [];
  const previewWidths = useMemo(
    () => (preview ? columnWidthsForContent(previewHeaders, preview.rows) : undefined),
    [preview, previewHeaders.join("\u0001")],
  );

  async function refresh() {
    const response = await datasetApi.list();
    setDatasets(response.datasets);
  }

  useEffect(() => {
    void refresh().catch((err) => toastError(messages.errors.workspace, err));
  }, [messages]);

  function toggleOne(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  function toggleAll() {
    setSelected(allSelected ? [] : files.map((item) => item.id));
  }

  async function deleteSelected() {
    if (selected.length === 0) return;
    const confirmed = await showConfirm(
      messages.transformFiles.deleteConfirmTitle,
      messages.transformFiles.deleteConfirmMessage(selected.length),
      { tone: "danger" },
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      for (const id of selected) {
        await datasetApi.delete(id);
      }
      if (previewing && selectedSet.has(previewing.id)) {
        setPreviewing(null);
        setPreview(null);
      }
      setSelected([]);
      await refresh();
    } catch (err) {
      toastDeleteError(messages.errors.deleteDataset, messages.errors.deleteBlocked, err);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function openPreview(item: Dataset) {
    if (!item.available) {
      toastError(messages.transformFiles.missing);
      return;
    }
    setPreviewing(item);
    setPreview(null);
    setPreviewLoading(true);
    try {
      const next = await datasetApi.inspect(item.id);
      setPreview(next.preview);
    } catch (err) {
      setPreviewing(null);
      toastError(messages.errors.inspect, err);
    } finally {
      setPreviewLoading(false);
    }
  }

  function closePreview() {
    setPreviewing(null);
    setPreview(null);
    setPreviewLoading(false);
  }

  return (
    <PageShell>
      <PageHeader
        iconName="jobs"
        eyebrow={messages.transformFiles.eyebrow}
        title={messages.transformFiles.title}
        description={messages.transformFiles.description}
      />
      <Panel tall>
        <Toolbar>
          <ToolbarGroup>
            <label className="flex items-center gap-2 text-[13px] font-semibold text-text">
              <input
                className="field-control"
                type="checkbox"
                checked={allSelected}
                disabled={files.length === 0 || busy}
                onChange={toggleAll}
                aria-label={messages.transformFiles.selectAll}
              />
              <span>{messages.transformFiles.resultFiles}</span>
            </label>
            <span className="rounded-full bg-subtle px-2 py-0.5 text-[10px] font-semibold tabular-nums text-text-secondary">
              {messages.common.count(files.length)}
            </span>
            <span className="ml-1 border-l border-border pl-3 text-xs font-normal text-text-tertiary">
              {messages.transformFiles.resultHint}
            </span>
          </ToolbarGroup>
          <ToolbarGroup>
            <Button
              type="button"
              variant="danger"
              disabled={selected.length === 0 || busy}
              onClick={() => void deleteSelected()}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {messages.transformFiles.deleteSelected}
            </Button>
          </ToolbarGroup>
        </Toolbar>
        <DataGrid
          className="min-h-0 flex-1"
          headers={[...messages.transformFiles.headers]}
          columnWidths={[56, 280, 100, 96, 140, 110]}
        >
          {files.length === 0 ? (
            <EmptyGridRow cols={6} text={messages.empty.transformFiles} />
          ) : (
            files.map((item) => (
              <GridRow
                key={item.id}
                selected={selectedSet.has(item.id)}
                onClick={() => void openPreview(item)}
              >
                <GridCell>
                  <input
                    className="field-control"
                    type="checkbox"
                    checked={selectedSet.has(item.id)}
                    disabled={busy}
                    aria-label={item.filename}
                    onChange={() => toggleOne(item.id)}
                    onClick={(event) => event.stopPropagation()}
                  />
                </GridCell>
                <GridCell>{item.filename}</GridCell>
                <GridCell mono muted>
                  {item.size_bytes != null ? fmtBytes(item.size_bytes) : "—"}
                </GridCell>
                <GridCell mono>{item.row_count ?? "—"}</GridCell>
                <GridCell mono muted>
                  {fmtWhen(item.created_at)}
                </GridCell>
                <GridCell>
                  {item.available ? (
                    <span onClick={(event) => event.stopPropagation()}>
                      <ActionAnchor href={datasetApi.getDownloadUrl(item.id)}>
                        {messages.common.download}
                      </ActionAnchor>
                    </span>
                  ) : (
                    <span className="text-xs text-danger">{messages.transformFiles.missing}</span>
                  )}
                </GridCell>
              </GridRow>
            ))
          )}
        </DataGrid>
      </Panel>

      <AppDialog
        open={Boolean(previewing)}
        title={previewing?.filename ?? messages.transformFiles.previewTitle}
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
                {messages.common.rows(preview.sampled_rows)}
              </MetaField>
              {preview.row_count != null ? (
                <MetaField label={messages.files.totalRows} technical>
                  {messages.common.rows(preview.row_count)}
                </MetaField>
              ) : null}
              {previewHeaders.length > 0 ? (
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-medium leading-none text-text-tertiary">
                    {messages.common.columns}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {preview.columns.map((column) => (
                      <span
                        key={column.name}
                        title={`${column.name} ${column.dtype}`}
                        className="max-w-full truncate rounded-full border border-border bg-raised px-2 py-0.5 text-[11px] font-medium text-text"
                      >
                        {column.name}
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
                {previewLoading
                  ? messages.transformFiles.previewLoading
                  : messages.transformFiles.previewEmpty}
              </div>
            ) : (
              <DataGrid
                className="h-full min-h-64"
                headers={previewHeaders}
                columnWidths={previewWidths}
              >
                {preview.rows.length === 0 ? (
                  <EmptyGridRow
                    cols={previewHeaders.length}
                    text={messages.transformFiles.previewEmpty}
                  />
                ) : (
                  preview.rows.map((row, index) => (
                    <GridRow key={index}>
                      {previewHeaders.map((_, cellIndex) => (
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
