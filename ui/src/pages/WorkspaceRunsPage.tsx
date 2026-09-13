import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Eye, History, ListFilter, RefreshCw, ScrollText, Search } from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { DataGrid, EmptyState, GridCell, GridRow } from "@/components/DataGrid";
import { NavIcon } from "@/components/ui/nav-icons";
import { LogDialog } from "@/components/LogDialog";
import { PaginationBar } from "@/components/PaginationBar";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { StatusPill } from "@/components/StatusPill";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { fmtWhen } from "@/lib/format";
import { toastError } from "@/lib/notifications";
import { usePagination } from "@/lib/pagination";
import { chipApi } from "@/services/chips/chipApi";
import { workspaceApi } from "@/services/workspace/workspaceApi";
import type { ChipRun, WorkspaceExecution } from "@/types/chip";

type RunRow = ChipRun & { workspaceName: string; chipName: string };
type WorkspaceRunRow = WorkspaceExecution & { workspaceName: string };
type TimeFilter = "all" | "today" | "7d" | "30d";

const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "skipped", "canceled"] as const;

function historyTab(value: string | null): "chip" | "workspace" {
  return value === "workspace" ? "workspace" : "chip";
}

function historyStatus(value: string | null) {
  return RUN_STATUSES.includes(value as (typeof RUN_STATUSES)[number]) ? value! : "all";
}

function runAt(run: { started_at?: string | null; created_at: string }) {
  return run.started_at || run.created_at;
}

function matchesTimeFilter(iso: string, range: TimeFilter, now = Date.now()) {
  if (range === "all") return true;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return false;
  if (range === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return at >= start.getTime();
  }
  return at >= now - (range === "7d" ? 7 : 30) * 86_400_000;
}

export function WorkspaceRunsPage() {
  const { messages } = useLanguage();
  const [searchParams] = useSearchParams();
  const tabParam = historyTab(searchParams.get("tab"));
  const statusParam = historyStatus(searchParams.get("status"));
  const [activeTab, setActiveTab] = useState<"chip" | "workspace">(tabParam);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [workspaceRuns, setWorkspaceRuns] = useState<WorkspaceRunRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [logRun, setLogRun] = useState<RunRow | null>(null);
  const [logText, setLogText] = useState("");
  const [chipQuery, setChipQuery] = useState("");
  const [chipStatus, setChipStatus] = useState(tabParam === "chip" ? statusParam : "all");
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const [workspaceStatus, setWorkspaceStatus] = useState(tabParam === "workspace" ? statusParam : "all");
  const [workspaceTime, setWorkspaceTime] = useState<TimeFilter>("all");

  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setLoading(true);
    try {
      const silent = options?.silent ? { silent: true as const } : undefined;
      const [workspaceResponse, chipResponse] = await Promise.all([
        workspaceApi.list(silent), chipApi.listCatalog(silent),
      ]);
      const chipMap = new Map(chipResponse.chips.map((chip) => [chip.id, chip.name]));
      const batches = await Promise.all(workspaceResponse.workspaces.map(async (workspace) => {
        const response = await chipApi.listRuns(workspace.id, silent);
        return {
          chips: response.runs.map((run) => ({ ...run, workspaceName: workspace.name,
            chipName: chipMap.get(run.chip_id) ?? messages.chipRuns.unknownChip })),
          workspaces: response.workspace_runs.map((run) => ({ ...run, workspaceName: workspace.name })),
        };
      }));
      setRuns(batches.flatMap((batch) => batch.chips).sort((a, b) => runAt(b).localeCompare(runAt(a))));
      setWorkspaceRuns(batches.flatMap((batch) => batch.workspaces).sort((a, b) => runAt(b).localeCompare(runAt(a))));
    } catch (error) {
      if (!options?.silent) toastError(messages.workspace.loadError, error);
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }, [messages]);

  useEffect(() => {
    setActiveTab(tabParam);
    setLogRun(null);
    setSelectedId(null);
    if (tabParam === "workspace") setWorkspaceStatus(statusParam);
    else setChipStatus(statusParam);
  }, [statusParam, tabParam]);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const poll = async (silent: boolean) => {
      await refresh({ silent });
      if (!stopped) timer = window.setTimeout(() => void poll(true), 2000);
    };
    void poll(false);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [refresh]);

  useEffect(() => {
    if (!logRun) return;
    let stopped = false;
    let timer: number | undefined;
    setLogText(messages.common.loading);
    const poll = async () => {
      try {
        const response = await chipApi.getRunLogs(logRun.id, { silent: true });
        if (!stopped) setLogText(response.text || messages.empty.logs);
      } catch (error) {
        if (!stopped) { setLogText(messages.empty.logs); toastError(messages.errors.list, error); }
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [logRun, messages]);

  const chipRuns = useMemo(() => {
    const query = chipQuery.trim().toLocaleLowerCase();
    return runs.filter((run) =>
      (!query || run.chipName.toLocaleLowerCase().includes(query))
      && (chipStatus === "all" || run.status === chipStatus),
    );
  }, [chipQuery, chipStatus, runs]);
  const visibleWorkspaceRuns = useMemo(() => {
    const query = workspaceQuery.trim().toLocaleLowerCase();
    return workspaceRuns.filter((run) =>
      (!query || run.workspaceName.toLocaleLowerCase().includes(query))
      && (workspaceStatus === "all" || run.status === workspaceStatus)
      && matchesTimeFilter(runAt(run), workspaceTime),
    );
  }, [workspaceQuery, workspaceRuns, workspaceStatus, workspaceTime]);
  const selectedRun = workspaceRuns.find((run) => run.id === selectedId);
  const steps = runs.filter((run) => run.execution_source === "workspace" && run.execution_id === selectedId)
    .sort((a, b) => runAt(a).localeCompare(runAt(b)));
  const status = (value: string) => <StatusPill value={value} label={value === "succeeded"
    ? messages.chipRuns.success : value === "running" ? messages.chipRuns.running : undefined} />;

  return (
    <PageShell fill>
      <PageHeader iconName="runs" eyebrow={messages.history.eyebrow} title={messages.chipRuns.title}
        description={messages.chipRuns.description}
        actions={<Button type="button" variant="secondary" disabled={loading} onClick={() => void refresh()}><RefreshCw className="size-3.5" aria-hidden="true" />{messages.common.refresh}</Button>} />
      <div role="tablist" aria-label={messages.chipRuns.title} className="flex shrink-0 gap-1 border-b border-border">
        {(["chip", "workspace"] as const).map((tab, index) => (
          <button
            key={tab}
            id={`run-history-tab-${tab}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            aria-controls={`run-history-panel-${tab}`}
            tabIndex={activeTab === tab ? 0 : -1}
            className={cn(
              "flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[-2px]",
              activeTab === tab ? "border-accent text-accent" : "border-transparent text-text-tertiary hover:text-text",
            )}
            onClick={() => { setActiveTab(tab); setLogRun(null); setSelectedId(null); }}
            onKeyDown={(event) => {
              const next = event.key === "Home" ? 0 : event.key === "End" ? 1
                : event.key === "ArrowLeft" || event.key === "ArrowRight" ? 1 - index : null;
              if (next === null) return;
              event.preventDefault();
              setActiveTab(next === 0 ? "chip" : "workspace");
              setLogRun(null);
              setSelectedId(null);
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
            }}
          >
            {tab === "chip" ? messages.chipRuns.chipHistory : messages.chipRuns.workspaceHistory}
            <span className="rounded bg-subtle px-1.5 py-0.5 text-xs tabular-nums">
              {tab === "chip" ? runs.length : workspaceRuns.length}
            </span>
          </button>
        ))}
      </div>
      <Panel fill role="tabpanel" id="run-history-panel-chip" aria-labelledby="run-history-tab-chip" hidden={activeTab !== "chip"} tabIndex={0}>
        {activeTab === "chip" && <>
        <Toolbar>
          <ToolbarGroup>
            <h2 className="text-[13px] font-semibold">{messages.chipRuns.chipHistory}</h2>
            <CountBadge count={chipRuns.length} />
          </ToolbarGroup>
        </Toolbar>
        <RunFilterBar
          query={chipQuery}
          onQuery={setChipQuery}
          queryLabel={messages.chipRuns.searchChip}
          queryPlaceholder={messages.chipRuns.searchChipPlaceholder}
          status={chipStatus}
          onStatus={setChipStatus}
        />
        <ChipRunGrid
          fill
          rows={chipRuns}
          loading={loading}
          status={status}
          onViewLog={setLogRun}
          filterEmpty={chipRuns.length === 0 && runs.length > 0}
          resetKey={`${chipQuery}|${chipStatus}`}
        />
        </>}
      </Panel>
      <Panel fill role="tabpanel" id="run-history-panel-workspace" aria-labelledby="run-history-tab-workspace" hidden={activeTab !== "workspace"} tabIndex={0}>
        {activeTab === "workspace" && <>
        <Toolbar>
          <ToolbarGroup>
            <h2 className="text-[13px] font-semibold">{messages.chipRuns.workspaceHistory}</h2>
            <CountBadge count={visibleWorkspaceRuns.length} />
            <span className="mx-1 h-3 w-px shrink-0 bg-border" aria-hidden="true" />
            <span className="text-xs text-text-tertiary">{messages.chipRuns.selectExecution}</span>
          </ToolbarGroup>
        </Toolbar>
        <RunFilterBar
          query={workspaceQuery}
          onQuery={setWorkspaceQuery}
          queryLabel={messages.chipRuns.searchWorkspace}
          queryPlaceholder={messages.chipRuns.searchWorkspacePlaceholder}
          status={workspaceStatus}
          onStatus={setWorkspaceStatus}
          time={workspaceTime}
          onTime={setWorkspaceTime}
        />
        <WorkspaceRunGrid
          fill
          rows={visibleWorkspaceRuns}
          runs={runs}
          loading={loading}
          status={status}
          onSelect={setSelectedId}
          filterEmpty={visibleWorkspaceRuns.length === 0 && workspaceRuns.length > 0}
          resetKey={`${workspaceQuery}|${workspaceStatus}|${workspaceTime}`}
        />
        </>}
      </Panel>
      <AppDialog
        open={Boolean(selectedRun)}
        title={selectedRun ? `${selectedRun.workspaceName} · ${fmtWhen(runAt(selectedRun))}` : ""}
        icon={<History className="size-4 text-accent" aria-hidden="true" />}
        headerExtra={selectedRun ? <div className="flex flex-1 items-center justify-end">{status(selectedRun.status)}</div> : null}
        className="h-[min(42rem,86vh)] w-[min(96rem,98vw)]"
        minWidth={720}
        minHeight={520}
        onClose={() => setSelectedId(null)}
      >
        {selectedRun ? (
          <ChipRunGrid fill key={selectedRun.id} rows={steps} loading={loading} status={status} onViewLog={setLogRun} />
        ) : null}
      </AppDialog>
      <LogDialog open={Boolean(logRun)} title={`${messages.chipRuns.viewLog} · ${logRun?.workspaceName ?? ""} · ${logRun?.chipName ?? ""} · ${logRun?.id.slice(0, 8) ?? ""}`}
        text={logText} icon={<History className="size-4 text-accent" aria-hidden="true" />} onClose={() => setLogRun(null)} />
    </PageShell>
  );
}

function ChipRunGrid({
  rows,
  loading,
  status,
  onViewLog,
  fill = false,
  filterEmpty = false,
  resetKey = "",
}: {
  rows: RunRow[];
  loading: boolean;
  status: (value: string) => ReactNode;
  onViewLog: (run: RunRow) => void;
  fill?: boolean;
  filterEmpty?: boolean;
  resetKey?: string;
}) {
  const { messages } = useLanguage();
  const paging = usePagination(rows, resetKey);
  const grid = (
    <>
      <DataGrid
        className={fill ? "min-h-0 flex-1" : "max-h-[360px]"}
        headers={[...messages.chipRuns.headers]}
        columnWidths={[180, 88, 120, 120, 180, 160, 120]}
        empty={
          loading ? <EmptyState title={messages.common.loading} />
          : rows.length === 0 ? (
            <EmptyState
              icon={<NavIcon name="runs" />}
              title={filterEmpty ? messages.chipRuns.filterEmpty : messages.chipRuns.noRuns}
              hint={filterEmpty ? messages.chipRuns.filterEmptyHint : messages.chipRuns.noRunsHint}
            />
          )
          : undefined
        }
      >
        {loading || rows.length === 0 ? null : paging.items.map((run) => (
            <GridRow key={run.id}>
              <GridCell>{run.chipName}</GridCell>
              <GridCell>{status(run.status)}</GridCell>
              <GridCell mono muted title={run.input_dataset_id ?? undefined}>{run.input_dataset_id?.slice(0, 8) ?? "—"}</GridCell>
              <GridCell mono muted title={run.output_dataset_id ?? undefined}>{run.output_dataset_id?.slice(0, 8) ?? "—"}</GridCell>
              <GridCell muted title={run.error_message ?? undefined}><span className="line-clamp-2">{run.error_message ?? "—"}</span></GridCell>
              <GridCell mono muted>{fmtWhen(runAt(run))}</GridCell>
              <GridCell><Button type="button" variant="quiet" onClick={() => onViewLog(run)}><ScrollText className="size-3.5" aria-hidden="true" />{messages.chipRuns.viewLog}</Button></GridCell>
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
    </>
  );
  return fill ? <div className="flex min-h-0 flex-1 flex-col">{grid}</div> : grid;
}

function WorkspaceRunGrid({
  rows,
  runs,
  loading,
  status,
  onSelect,
  fill = false,
  filterEmpty = false,
  resetKey = "",
}: {
  rows: WorkspaceRunRow[];
  runs: RunRow[];
  loading: boolean;
  status: (value: string) => ReactNode;
  onSelect: (id: string) => void;
  fill?: boolean;
  filterEmpty?: boolean;
  resetKey?: string;
}) {
  const { messages } = useLanguage();
  const paging = usePagination(rows, resetKey);
  return (
    <>
      <DataGrid
        className={fill ? "min-h-0 flex-1" : "max-h-[360px]"}
        headers={[...messages.chipRuns.workspaceHeaders]}
        columnWidths={[200, 88, 140, 140, 140, 180, 140]}
        empty={
          loading ? <EmptyState title={messages.common.loading} />
          : rows.length === 0 ? (
            <EmptyState
              icon={<NavIcon name="runs" />}
              title={filterEmpty ? messages.chipRuns.filterEmpty : messages.chipRuns.noRuns}
              hint={filterEmpty ? messages.chipRuns.filterEmptyHint : messages.chipRuns.noRunsHint}
            />
          )
          : undefined
        }
      >
        {loading || rows.length === 0 ? null : paging.items.map((run) => {
            const children = runs.filter((step) => step.execution_source === "workspace" && step.execution_id === run.id);
            const succeeded = children.filter((step) => step.status === "succeeded").length;
            return <GridRow key={run.id}>
              <GridCell><Link className="font-medium text-accent hover:underline" to={`/workspace/${run.workspace_id}`}>{run.workspaceName}</Link></GridCell>
              <GridCell>{status(run.status)}</GridCell>
              <GridCell>{children.length === 0 ? "—" : messages.chipRuns.chipProgress(succeeded, children.length)}</GridCell>
              <GridCell mono muted>{fmtWhen(runAt(run))}</GridCell>
              <GridCell mono muted>{run.finished_at ? fmtWhen(run.finished_at) : "—"}</GridCell>
              <GridCell muted title={run.error_message ?? undefined}><span className="line-clamp-2">{run.error_message ?? "—"}</span></GridCell>
              <GridCell>
                <Button type="button" variant="quiet" onClick={() => onSelect(run.id)}>
                  <Eye className="size-3.5" aria-hidden="true" />
                  {messages.chipRuns.viewDetail}
                </Button>
              </GridCell>
            </GridRow>;
          })}
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
    </>
  );
}

function RunFilterBar({
  query,
  onQuery,
  queryLabel,
  queryPlaceholder,
  status,
  onStatus,
  time,
  onTime,
}: {
  query: string;
  onQuery: (value: string) => void;
  queryLabel: string;
  queryPlaceholder: string;
  status: string;
  onStatus: (value: string) => void;
  time?: TimeFilter;
  onTime?: (value: TimeFilter) => void;
}) {
  const { messages } = useLanguage();
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-raised/45 px-3 py-2.5">
      <div className="group flex h-8 w-[min(17rem,100%)] min-w-[11rem] items-center overflow-hidden rounded-lg border border-border bg-surface shadow-sm transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
        <span className="grid h-full w-8 shrink-0 place-items-center border-r border-border bg-subtle text-text-tertiary group-focus-within:text-accent">
          <Search className="size-3.5" aria-hidden="true" />
        </span>
        <input
          type="search"
          className="min-w-0 flex-1 bg-transparent px-2.5 text-[13px] text-text outline-none placeholder:text-text-tertiary"
          value={query}
          placeholder={queryPlaceholder}
          aria-label={queryLabel}
          onChange={(event) => onQuery(event.target.value)}
        />
      </div>
      <div className="ml-3 flex items-center gap-1.5 text-xs text-text-secondary">
        <ListFilter className="size-3.5 text-text-tertiary" aria-hidden="true" />
        <span className="sr-only">{messages.chipRuns.statusFilter}</span>
        <Select
          className="h-8 min-w-[6.5rem]"
          value={status}
          onChange={onStatus}
          options={[
            { value: "all", label: messages.chips.allStatuses },
            ...RUN_STATUSES.map((value) => ({ value, label: messages.status[value] })),
          ]}
        />
      </div>
      {time && onTime ? (
        <div className="flex items-center text-xs text-text-secondary">
          <span className="sr-only">{messages.chipRuns.timeFilter}</span>
          <Select
            className="h-8 min-w-[7.5rem]"
            value={time}
            onChange={(value) => onTime(value as TimeFilter)}
            options={[
              { value: "all", label: messages.chipRuns.timeAll },
              { value: "today", label: messages.chipRuns.timeToday },
              { value: "7d", label: messages.chipRuns.time7d },
              { value: "30d", label: messages.chipRuns.time30d },
            ]}
          />
        </div>
      ) : null}
    </div>
  );
}

function CountBadge({ count }: { count: number }) {
  const { messages } = useLanguage();
  return (
    <span className="shrink-0 rounded-full bg-accent-subtle px-2 py-0.5 text-[11px] font-bold tabular-nums text-accent">
      {messages.common.cases(count)}
    </span>
  );
}

if (import.meta.env.DEV) {
  const noon = Date.parse("2026-09-13T12:00:00.000Z");
  const start = new Date(noon);
  start.setHours(0, 0, 0, 0);
  console.assert(matchesTimeFilter(new Date(start.getTime() + 3_600_000).toISOString(), "today", noon), "time filter: today includes morning");
  console.assert(!matchesTimeFilter(new Date(start.getTime() - 3_600_000).toISOString(), "today", noon), "time filter: today excludes yesterday");
  console.assert(matchesTimeFilter("2026-09-07T12:00:00.000Z", "7d", noon), "time filter: 7d includes day 6");
  console.assert(!matchesTimeFilter("2026-08-01T12:00:00.000Z", "30d", noon), "time filter: 30d excludes old");
}
