import { useMemo, useState } from "react";
import { FileSpreadsheet, Trash2 } from "lucide-react";
import {
  columnWidthsForContent,
  DataGrid,
  EmptyGridRow,
  GridCell,
  GridRow,
} from "@/components/DataGrid";
import { AppDialog } from "@/components/AppDialog";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { StatusPill } from "@/components/StatusPill";
import { ActionAnchor, Button } from "@/components/ui/button";
import { LiveDot } from "@/components/ui/live-dot";
import { MetaField } from "@/components/ui/meta-field";
import { Panel } from "@/components/ui/panel";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { isExtractActive, useExtracts } from "@/hooks/extract/useExtracts";
import { useLanguage } from "@/i18n/LanguageProvider";
import type { Messages } from "@/i18n/ko";
import { cn } from "@/lib/cn";
import { fmtDelimiterGlyph, fmtSqlPreview, fmtWhen } from "@/lib/format";
import { showConfirm, toastDeleteError, toastError } from "@/lib/notifications";
import { extractApi } from "@/services/extract/extractApi";
import type { ExtractKind, ExtractRecord } from "@/types/extract";
import type { FilePreview } from "@/types/file";

function kindOf(extract: ExtractRecord): ExtractKind {
  return extract.kind === "api" ? "api" : "database";
}

function kindLabel(kind: ExtractKind, messages: Messages): string {
  if (kind === "api") return messages.extracts.kindApi;
  return messages.extracts.kindDatabase;
}

function extractFilename(extract: ExtractRecord): string {
  if (extract.filename?.trim()) return extract.filename;
  if (extract.stored_path) {
    const base = extract.stored_path.split(/[/\\]/).pop();
    if (base) return base;
  }
  return extract.table_name || "—";
}

function extractOrigin(extract: ExtractRecord, messages: Messages): { text: string; title?: string } {
  const sql = extract.sql_text?.trim();
  if (sql) {
    return {
      text: `${messages.extracts.querySource} · ${fmtSqlPreview(sql)}`,
      title: sql,
    };
  }
  return { text: extract.table_name || "—" };
}

export function ExtractResultsPage() {
  const { messages } = useLanguage();
  const { extracts, refreshExtracts } = useExtracts();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState<ExtractRecord | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const allSelected = extracts.length > 0 && selected.length === extracts.length;
  const activeCount = extracts.filter((extract) => isExtractActive(extract.status)).length;
  const previewWidths = useMemo(
    () => (preview ? columnWidthsForContent(preview.columns, preview.rows) : undefined),
    [preview],
  );

  function toggleOne(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  function toggleAll() {
    setSelected(allSelected ? [] : extracts.map((extract) => extract.id));
  }

  async function deleteSelected() {
    if (selected.length === 0) return;
    const confirmed = await showConfirm(
      messages.extracts.deleteConfirmTitle,
      messages.extracts.deleteConfirmMessage(selected.length),
      { tone: "danger", confirmLabel: messages.common.delete },
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      for (const id of selected) {
        await extractApi.deleteExtract(id);
      }
      if (previewing && selectedSet.has(previewing.id)) {
        setPreviewing(null);
        setPreview(null);
      }
      setSelected([]);
      await refreshExtracts();
    } catch (err) {
      toastDeleteError(messages.errors.deleteExtract, messages.errors.deleteBlocked, err);
      await refreshExtracts();
    } finally {
      setBusy(false);
    }
  }

  async function openPreview(extract: ExtractRecord) {
    if (extract.status !== "succeeded") {
      toastError(messages.extracts.previewOnlySucceeded);
      return;
    }
    setPreviewing(extract);
    setPreview(null);
    setPreviewLoading(true);
    try {
      const next = await extractApi.previewExtract(extract.id);
      setPreview(next);
    } catch (err) {
      setPreviewing(null);
      toastError(messages.errors.extractPreview, err);
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
        iconName="extracts"
        eyebrow={messages.extracts.eyebrow}
        title={messages.extracts.title}
        description={messages.extracts.description}
        actions={activeCount > 0 ? <LiveDot label={messages.extracts.generating(activeCount)} /> : null}
      />

      <Panel tall>
        <Toolbar>
          <ToolbarGroup>
            <label className="flex items-center gap-2 text-[13px] font-semibold text-text">
              <input
                className="field-control"
                type="checkbox"
                checked={allSelected}
                disabled={extracts.length === 0 || busy}
                onChange={toggleAll}
                aria-label={messages.extracts.selectAll}
              />
              <span>{messages.extracts.resultFiles}</span>
            </label>
            <span className="rounded-full bg-subtle px-2 py-0.5 text-[10px] font-semibold tabular-nums text-text-secondary">
              {messages.common.count(extracts.length)}
            </span>
            <span className="ml-1 border-l border-border pl-3 text-xs font-normal text-text-tertiary">
              {messages.extracts.resultHint}
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
              {messages.extracts.deleteSelected}
            </Button>
          </ToolbarGroup>
        </Toolbar>
        <DataGrid
          className="min-h-0 flex-1"
          headers={[...messages.extracts.headers]}
          columnWidths={[56, 180, 72, 130, 220, 96, 100, 130, 110]}
        >
          {extracts.length === 0 ? (
            <EmptyGridRow cols={9} text={messages.empty.extracts} />
          ) : (
            extracts.map((extract) => {
              const kind = kindOf(extract);
              const origin = extractOrigin(extract, messages);
              const name = extractFilename(extract);
              return (
                <GridRow
                  key={extract.id}
                  selected={selectedSet.has(extract.id)}
                  onClick={() => void openPreview(extract)}
                >
                  <GridCell>
                    <input
                      className="field-control"
                      type="checkbox"
                      checked={selectedSet.has(extract.id)}
                      disabled={busy}
                      aria-label={name}
                      onChange={() => toggleOne(extract.id)}
                      onClick={(event) => event.stopPropagation()}
                    />
                  </GridCell>
                  <GridCell>{name}</GridCell>
                  <GridCell>
                    <span
                      className={cn(
                        "inline-flex rounded-md px-1.5 py-0.5 text-[11px] font-semibold",
                        kind === "api"
                          ? "bg-subtle text-text-secondary"
                          : "bg-accent-subtle text-accent",
                      )}
                    >
                      {kindLabel(kind, messages)}
                    </span>
                  </GridCell>
                  <GridCell>
                    {extract.connection_name || extract.connection_id.slice(0, 8) || "—"}
                  </GridCell>
                  <GridCell mono>
                    <span title={origin.title}>{origin.text}</span>
                  </GridCell>
                  <GridCell>
                    <StatusPill value={extract.status} />
                  </GridCell>
                  <GridCell mono>
                    {extract.status === "queued" || extract.status === "running"
                      ? extract.row_count != null
                        ? messages.extracts.writing(extract.row_count)
                        : extract.status === "running"
                          ? messages.common.running
                          : "—"
                      : extract.row_count ?? "—"}
                  </GridCell>
                  <GridCell mono muted>
                    {fmtWhen(extract.created_at)}
                  </GridCell>
                  <GridCell>
                    {extract.status === "succeeded" ? (
                      <span onClick={(event) => event.stopPropagation()}>
                        <ActionAnchor href={extractApi.getDownloadUrl(extract.id)}>
                          {messages.common.download}
                        </ActionAnchor>
                      </span>
                    ) : extract.error_message ? (
                      <span className="text-xs text-danger">{extract.error_message}</span>
                    ) : (
                      <span className="text-text-tertiary">—</span>
                    )}
                  </GridCell>
                </GridRow>
              );
            })
          )}
        </DataGrid>
      </Panel>

      <AppDialog
        open={Boolean(previewing)}
        title={previewing ? extractFilename(previewing) : messages.extracts.previewTitle}
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
              <MetaField label={messages.extracts.previewRows} technical>
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
                {previewLoading ? messages.extracts.previewLoading : messages.extracts.previewEmpty}
              </div>
            ) : (
              <DataGrid
                className="h-full min-h-64"
                headers={preview.columns}
                columnWidths={previewWidths}
              >
                {preview.rows.length === 0 ? (
                  <EmptyGridRow cols={preview.columns.length} text={messages.extracts.previewEmpty} />
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
