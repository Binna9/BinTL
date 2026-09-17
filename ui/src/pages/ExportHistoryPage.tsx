import { useCallback, useEffect, useState } from "react";
import { Download, History, RefreshCw, ScrollText } from "lucide-react";
import { DataGrid, EmptyState, GridCell, GridRow } from "@/components/DataGrid";
import { LogDialog } from "@/components/LogDialog";
import { PaginationBar } from "@/components/PaginationBar";
import { NavIcon } from "@/components/ui/nav-icons";
import { StatusPill } from "@/components/StatusPill";
import { ActionAnchor, Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
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

export function ExportHistoryPage() {
  const { messages } = useLanguage();
  const t = messages.history;
  const [rows, setRows] = useState<ExportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [logRow, setLogRow] = useState<ExportRow | null>(null);
  const [logText, setLogText] = useState("");

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

  const paging = usePagination(rows);
  const kindLabel = (kind: ExportKind) =>
    kind === "extract" ? t.kindExtract : t.kindTransform;

  return (
    <PageShell>
      <PageHeader
        iconName="jobs"
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
      <Panel tall className="overflow-hidden">
        <DataGrid
          className="min-h-0 flex-1"
          headers={[...t.exportsHeaders]}
          columnWidths={[88, 280, 100, 96, 160, 100, 100]}
          empty={
            loading ? (
              <EmptyState title={messages.common.loading} />
            ) : (
              <EmptyState
                icon={<NavIcon name="jobs" />}
                title={t.empty}
                hint={t.emptyHint}
              />
            )
          }
        >
          {loading || rows.length === 0
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
