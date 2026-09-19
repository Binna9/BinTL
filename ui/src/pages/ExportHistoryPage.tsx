import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, History, ListFilter, RefreshCw, ScrollText, Search } from "lucide-react";
import { DataGrid, EmptyState, GridCell, GridRow } from "@/components/DataGrid";
import { LogDialog } from "@/components/LogDialog";
import { PaginationBar } from "@/components/PaginationBar";
import { NavIcon } from "@/components/ui/nav-icons";
import { StatusPill } from "@/components/StatusPill";
import { ActionAnchor, Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { useLanguage } from "@/i18n/LanguageProvider";
import { fmtWhen } from "@/lib/format";
import { usePagination } from "@/lib/pagination";
import { toastError } from "@/lib/notifications";
import { extractApi } from "@/services/extract/extractApi";
import { jobApi } from "@/services/jobs/jobApi";
import type { ExtractRecord } from "@/types/extract";
import type { EtlJob, EtlJobLog } from "@/types/job";

type ExportKind = "extract" | "transform";

type ExportRow = {
  id: string;
  kind: ExportKind;
  filename: string;
  status: string;
  row_count: number | null;
  created_at: string;
  downloadUrl: string | null;
};

const EXPORT_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
const EXPORT_KINDS = ["extract", "transform"] as const;

function extractFilename(extract: ExtractRecord): string {
  if (extract.filename?.trim()) return extract.filename;
  if (extract.stored_path) {
    const base = extract.stored_path.split(/[/\\]/).pop();
    if (base) return base;
  }
  return extract.table_name || "—";
}

function jobFilename(job: EtlJob): string {
  return job.filename?.trim() || job.output_path?.split(/[/\\]/).pop() || "result.parquet";
}

function formatJobLogs(logs: EtlJobLog[], empty: string): string {
  if (logs.length === 0) return empty;
  return logs
    .map((log) => `${fmtWhen(log.ts)}  ${log.level.padEnd(5)}  ${log.message}`)
    .join("\n");
}

function filterExportRows(
  rows: ExportRow[],
  query: string,
  status: string,
  kind: "all" | ExportKind,
) {
  const q = query.trim().toLocaleLowerCase();
  return rows.filter(
    (row) =>
      (!q || row.filename.toLocaleLowerCase().includes(q))
      && (status === "all" || row.status === status)
      && (kind === "all" || row.kind === kind),
  );
}

export function ExportHistoryPage() {
  const { messages } = useLanguage();
  const t = messages.history;
  const [rows, setRows] = useState<ExportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [logRow, setLogRow] = useState<ExportRow | null>(null);
  const [logText, setLogText] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [kind, setKind] = useState<"all" | ExportKind>("all");

  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setLoading(true);
    try {
      const silent = options?.silent ? { silent: true as const } : undefined;
      const [extracts, jobs] = await Promise.all([
        extractApi.getExtracts(200, silent),
        jobApi.list(200, silent),
      ]);
      const extractRows: ExportRow[] = extracts.extracts.map((extract) => ({
        id: extract.id,
        kind: "extract",
        filename: extractFilename(extract),
        status: extract.status,
        row_count: extract.row_count,
        created_at: extract.created_at,
        downloadUrl: extract.status === "succeeded" ? extractApi.getDownloadUrl(extract.id) : null,
      }));
      const jobRows: ExportRow[] = jobs.jobs.map((job) => ({
        id: job.id,
        kind: "transform",
        filename: jobFilename(job),
        status: job.status,
        row_count: job.row_count ?? null,
        created_at: job.created_at,
        downloadUrl: job.status === "succeeded" ? jobApi.getResultUrl(job.id) : null,
      }));
      setRows(
        [...extractRows, ...jobRows].sort((a, b) => b.created_at.localeCompare(a.created_at)),
      );
    } catch (error) {
      if (!options?.silent) toastError(messages.errors.list, error);
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }, [messages]);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const poll = async (silent: boolean) => {
      await refresh({ silent });
      if (!stopped) timer = window.setTimeout(() => void poll(true), 2000);
    };
    void poll(false);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!logRow) return;
    let stopped = false;
    let timer: number | undefined;
    setLogText(messages.common.loading);
    const poll = async () => {
      try {
        if (logRow.kind === "extract") {
          const logs = await extractApi.getLogs(logRow.id, { silent: true });
          if (!stopped) setLogText(logs.text || messages.empty.logs);
        } else {
          const job = await jobApi.getJobRun(logRow.id);
          if (!stopped) setLogText(formatJobLogs(job.logs, messages.empty.logs));
        }
      } catch {
        if (!stopped) setLogText(messages.empty.logs);
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [logRow, messages]);

  const visible = useMemo(
    () => filterExportRows(rows, query, status, kind),
    [kind, query, rows, status],
  );
  const paging = usePagination(visible, `${query}|${status}|${kind}`);
  const filterEmpty = visible.length === 0 && rows.length > 0;
  const kindLabel = (value: ExportKind) =>
    value === "extract" ? t.kindExtract : t.kindTransform;

  return (
    <PageShell>
      <PageHeader
        iconName="exportHistory"
        eyebrow={t.eyebrow}
        title={t.exports}
        description={t.exportsDescription}
        actions={
          <Button type="button" variant="secondary" disabled={loading} onClick={() => void refresh()}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {messages.common.refresh}
          </Button>
        }
      />
      <Panel>
        <Toolbar>
          <ToolbarGroup>
            <h2 className="text-[13px] font-semibold">{t.exports}</h2>
            <span className="shrink-0 rounded-full bg-accent-subtle px-2 py-0.5 text-[11px] font-bold tabular-nums text-accent">
              {messages.common.cases(visible.length)}
            </span>
          </ToolbarGroup>
        </Toolbar>
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-raised/45 px-3 py-2.5">
          <div className="group flex h-8 w-[min(17rem,100%)] min-w-[11rem] items-center overflow-hidden rounded-lg border border-border bg-surface shadow-sm transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
            <span className="grid h-full w-8 shrink-0 place-items-center border-r border-border bg-subtle text-text-tertiary group-focus-within:text-accent">
              <Search className="size-3.5" aria-hidden="true" />
            </span>
            <input
              type="search"
              className="min-w-0 flex-1 bg-transparent px-2.5 text-[13px] text-text outline-none placeholder:text-text-tertiary"
              value={query}
              placeholder={t.searchFilenamePlaceholder}
              aria-label={t.searchFilename}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="ml-3 flex items-center gap-1.5 text-xs text-text-secondary">
            <ListFilter className="size-3.5 text-text-tertiary" aria-hidden="true" />
            <span className="sr-only">{messages.chipRuns.statusFilter}</span>
            <Select
              className="h-8 min-w-[6.5rem]"
              value={status}
              onChange={setStatus}
              options={[
                { value: "all", label: messages.chips.allStatuses },
                ...EXPORT_STATUSES.map((value) => ({ value, label: messages.status[value] })),
              ]}
            />
          </div>
          <div className="flex items-center text-xs text-text-secondary">
            <span className="sr-only">{messages.chips.kindFilter}</span>
            <Select
              className="h-8 min-w-[7.5rem]"
              value={kind}
              onChange={(value) => setKind(value === "extract" || value === "transform" ? value : "all")}
              options={[
                { value: "all", label: messages.chips.allKinds },
                ...EXPORT_KINDS.map((value) => ({ value, label: kindLabel(value) })),
              ]}
            />
          </div>
        </div>
        <DataGrid
          headers={[...t.exportsHeaders]}
          columnWidths={[88, 280, 100, 96, 160, 100, 100]}
          empty={
            loading ? (
              <EmptyState title={messages.common.loading} />
            ) : visible.length === 0 ? (
              <EmptyState
                icon={<NavIcon name="exportHistory" />}
                title={filterEmpty ? messages.chipRuns.filterEmpty : t.empty}
                hint={filterEmpty ? messages.chipRuns.filterEmptyHint : t.emptyHint}
              />
            ) : undefined
          }
        >
          {loading || visible.length === 0
            ? null
            : paging.items.map((row) => (
                <GridRow key={`${row.kind}-${row.id}`}>
                  <GridCell>{kindLabel(row.kind)}</GridCell>
                  <GridCell title={row.filename}>{row.filename}</GridCell>
                  <GridCell>
                    <StatusPill value={row.status} />
                  </GridCell>
                  <GridCell mono muted>
                    {row.row_count != null ? messages.common.rows(row.row_count) : "—"}
                  </GridCell>
                  <GridCell mono muted>
                    {fmtWhen(row.created_at)}
                  </GridCell>
                  <GridCell>
                    {row.downloadUrl ? (
                      <ActionAnchor href={row.downloadUrl}>
                        <Download className="size-3.5" aria-hidden="true" />
                        {messages.common.download}
                      </ActionAnchor>
                    ) : (
                      "—"
                    )}
                  </GridCell>
                  <GridCell>
                    <Button type="button" variant="quiet" onClick={() => setLogRow(row)}>
                      <ScrollText className="size-3.5" aria-hidden="true" />
                      {messages.chipRuns.viewLog}
                    </Button>
                  </GridCell>
                </GridRow>
              ))}
        </DataGrid>
        <PaginationBar
          page={paging.page}
          pageCount={paging.pageCount}
          pageSize={paging.pageSize}
          total={paging.total}
          start={paging.start}
          end={paging.end}
          disabled={loading}
          onPageChange={paging.setPage}
          onPageSizeChange={paging.setPageSize}
        />
      </Panel>
      <LogDialog
        open={Boolean(logRow)}
        title={`${messages.chipRuns.viewLog} · ${logRow ? kindLabel(logRow.kind) : ""} · ${logRow?.filename ?? ""}`}
        text={logText}
        icon={<History className="size-4 text-accent" aria-hidden="true" />}
        onClose={() => setLogRow(null)}
      />
    </PageShell>
  );
}

if (import.meta.env.DEV) {
  const rows: ExportRow[] = [
    { id: "1", kind: "extract", filename: "sales.csv", status: "succeeded", row_count: 1, created_at: "2", downloadUrl: null },
    { id: "2", kind: "transform", filename: "sales.parquet", status: "failed", row_count: null, created_at: "1", downloadUrl: null },
  ];
  console.assert(filterExportRows(rows, "sales", "all", "all").length === 2, "export filter: filename");
  console.assert(filterExportRows(rows, "", "failed", "all").map((row) => row.id).join(",") === "2", "export filter: status");
  console.assert(filterExportRows(rows, "", "all", "extract").map((row) => row.id).join(",") === "1", "export filter: kind");
}
