import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { History, RefreshCw, ScrollText } from "lucide-react";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { LogDialog } from "@/components/LogDialog";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { StatusPill } from "@/components/StatusPill";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { fmtWhen } from "@/lib/format";
import { toastError } from "@/lib/notifications";
import { chipApi } from "@/services/chips/chipApi";
import { workspaceApi } from "@/services/workspace/workspaceApi";
import type { ChipRun, WorkspaceExecution } from "@/types/chip";

type RunRow = ChipRun & { workspaceName: string; chipName: string };
type WorkspaceRunRow = WorkspaceExecution & { workspaceName: string };

export function WorkspaceRunsPage() {
  const { messages } = useLanguage();
  const [activeTab, setActiveTab] = useState<"chip" | "workspace">("chip");
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [workspaceRuns, setWorkspaceRuns] = useState<WorkspaceRunRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [logRun, setLogRun] = useState<RunRow | null>(null);
  const [logText, setLogText] = useState("");

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
      setRuns(batches.flatMap((batch) => batch.chips).sort((a, b) => b.created_at.localeCompare(a.created_at)));
      setWorkspaceRuns(batches.flatMap((batch) => batch.workspaces).sort((a, b) => b.created_at.localeCompare(a.created_at)));
    } catch (error) {
      if (!options?.silent) toastError(messages.workspace.loadError, error);
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

  const chipRuns = runs.filter((run) => run.execution_source === "chip");
  const selectedRun = workspaceRuns.find((run) => run.id === selectedId);
  const steps = runs.filter((run) => run.execution_source === "workspace" && run.execution_id === selectedId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const status = (value: string) => <StatusPill value={value} label={value === "succeeded"
    ? messages.chipRuns.success : value === "running" ? messages.chipRuns.running : undefined} />;

  function chipGrid(rows: RunRow[]) {
    return (
      <DataGrid className="max-h-[360px]" headers={[...messages.chipRuns.headers]}>
        {loading ? <EmptyGridRow cols={8} text={messages.common.loading} />
          : rows.length === 0 ? <EmptyGridRow cols={8} text={messages.chipRuns.noRuns} />
          : rows.map((run) => (
            <GridRow key={run.id}>
              <GridCell><Link className="truncate font-medium text-accent hover:underline" to={`/workspace/${run.workspace_id}`}>{run.workspaceName}</Link></GridCell>
              <GridCell>{run.chipName}</GridCell>
              <GridCell>{status(run.status)}</GridCell>
              <GridCell mono muted title={run.input_dataset_id ?? undefined}>{run.input_dataset_id?.slice(0, 8) ?? "—"}</GridCell>
              <GridCell mono muted title={run.output_dataset_id ?? undefined}>{run.output_dataset_id?.slice(0, 8) ?? "—"}</GridCell>
              <GridCell muted title={run.error_message ?? undefined}><span className="line-clamp-2">{run.error_message ?? "—"}</span></GridCell>
              <GridCell mono muted>{fmtWhen(run.created_at)}</GridCell>
              <GridCell><Button type="button" variant="quiet" onClick={() => setLogRun(run)}><ScrollText className="size-3.5" aria-hidden="true" />{messages.chipRuns.viewLog}</Button></GridCell>
            </GridRow>
          ))}
      </DataGrid>
    );
  }

  return (
    <PageShell>
      <PageHeader iconName="jobs" eyebrow={messages.chipRuns.eyebrow} title={messages.chipRuns.title}
        description={messages.chipRuns.description}
        actions={<Button type="button" variant="secondary" disabled={loading} onClick={() => void refresh()}><RefreshCw className="size-3.5" aria-hidden="true" />{messages.common.refresh}</Button>} />
      <div role="tablist" aria-label={messages.chipRuns.title} className="flex gap-1 border-b border-border">
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
            onClick={() => { setActiveTab(tab); setLogRun(null); }}
            onKeyDown={(event) => {
              const next = event.key === "Home" ? 0 : event.key === "End" ? 1
                : event.key === "ArrowLeft" || event.key === "ArrowRight" ? 1 - index : null;
              if (next === null) return;
              event.preventDefault();
              setActiveTab(next === 0 ? "chip" : "workspace");
              setLogRun(null);
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
            }}
          >
            {tab === "chip" ? messages.chipRuns.chipHistory : messages.chipRuns.workspaceHistory}
            <span className="rounded bg-subtle px-1.5 py-0.5 text-xs tabular-nums">
              {tab === "chip" ? chipRuns.length : workspaceRuns.length}
            </span>
          </button>
        ))}
      </div>
      <Panel role="tabpanel" id="run-history-panel-chip" aria-labelledby="run-history-tab-chip" hidden={activeTab !== "chip"} tabIndex={0}>
        {activeTab === "chip" && <>
        <Toolbar><ToolbarGroup><h2 className="text-[13px] font-semibold">{messages.chipRuns.chipHistory}</h2><span className="text-xs text-text-tertiary">{messages.common.cases(chipRuns.length)}</span></ToolbarGroup></Toolbar>
        {chipGrid(chipRuns)}
        </>}
      </Panel>
      <Panel role="tabpanel" id="run-history-panel-workspace" aria-labelledby="run-history-tab-workspace" hidden={activeTab !== "workspace"} tabIndex={0}>
        {activeTab === "workspace" && <>
        <Toolbar><ToolbarGroup><h2 className="text-[13px] font-semibold">{messages.chipRuns.workspaceHistory}</h2><span className="text-xs text-text-tertiary">{messages.common.cases(workspaceRuns.length)}</span></ToolbarGroup></Toolbar>
        <DataGrid className="max-h-[360px]" headers={[...messages.chipRuns.workspaceHeaders]}>
          {loading ? <EmptyGridRow cols={7} text={messages.common.loading} />
            : workspaceRuns.length === 0 ? <EmptyGridRow cols={7} text={messages.chipRuns.noRuns} />
            : workspaceRuns.map((run) => {
              const children = runs.filter((step) => step.execution_id === run.id);
              return <GridRow key={run.id}>
                <GridCell><Link className="font-medium text-accent hover:underline" to={`/workspace/${run.workspace_id}`}>{run.workspaceName}</Link></GridCell>
                <GridCell>{status(run.status)}</GridCell>
                <GridCell mono>{children.filter((step) => step.status === "succeeded").length} / {children.length}</GridCell>
                <GridCell mono muted>{fmtWhen(run.started_at ?? run.created_at)}</GridCell>
                <GridCell mono muted>{run.finished_at ? fmtWhen(run.finished_at) : "—"}</GridCell>
                <GridCell muted title={run.error_message ?? undefined}><span className="line-clamp-2">{run.error_message ?? "—"}</span></GridCell>
                <GridCell><Button type="button" variant={selectedId === run.id ? "secondary" : "quiet"} aria-pressed={selectedId === run.id} onClick={() => setSelectedId(run.id)}>{messages.chipRuns.viewSteps}</Button></GridCell>
              </GridRow>;
            })}
        </DataGrid>
        {selectedRun ? <div className="border-t border-border">
          <Toolbar><ToolbarGroup><span className="text-[13px] font-semibold">{selectedRun.workspaceName} · {fmtWhen(selectedRun.created_at)} · {selectedRun.id.slice(0, 8)}</span>{status(selectedRun.status)}</ToolbarGroup></Toolbar>
          {chipGrid(steps)}
        </div> : <p className="border-t border-border p-4 text-xs text-text-tertiary">{messages.chipRuns.selectExecution}</p>}
        </>}
      </Panel>
      <LogDialog open={Boolean(logRun)} title={`${messages.chipRuns.viewLog} · ${logRun?.workspaceName ?? ""} · ${logRun?.chipName ?? ""} · ${logRun?.id.slice(0, 8) ?? ""}`}
        text={logText} icon={<History className="size-4 text-accent" aria-hidden="true" />} onClose={() => setLogRun(null)} />
    </PageShell>
  );
}
