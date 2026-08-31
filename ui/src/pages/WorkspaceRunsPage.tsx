import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { History, RefreshCw, ScrollText } from "lucide-react";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { LogDialog } from "@/components/LogDialog";
import { PageHeader, PageShell } from "@/components/PageShell";
import { StatusPill } from "@/components/StatusPill";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { useLanguage } from "@/i18n/LanguageProvider";
import { fmtWhen } from "@/lib/format";
import { toastError } from "@/lib/notifications";
import { chipApi } from "@/services/chipApi";
import { workspaceApi } from "@/services/workspaceApi";
import type { ChipRun } from "@/types/chip";

type RunRow = ChipRun & {
  workspaceName: string;
  chipName: string;
};

const ACTIVE = new Set(["queued", "running"]);

export function WorkspaceRunsPage() {
  const { messages } = useLanguage();
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [logId, setLogId] = useState<string | null>(null);
  const [logText, setLogText] = useState("");

  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setLoading(true);
    try {
      const silent = options?.silent ? { silent: true as const } : undefined;
      const [workspaceResponse, chipResponse] = await Promise.all([
        workspaceApi.list(silent),
        chipApi.listCatalog(silent),
      ]);
      const workspaceMap = new Map(
        workspaceResponse.workspaces.map((workspace) => [workspace.id, workspace.name] as const),
      );
      const chipMap = new Map(chipResponse.chips.map((chip) => [chip.id, chip] as const));

      const batches = await Promise.all(
        workspaceResponse.workspaces.map(async (workspace) => {
          const response = await chipApi.listRuns(workspace.id, silent);
          return response.runs.map((run) => ({
            ...run,
            workspaceName: workspaceMap.get(run.workspace_id) ?? messages.chipRuns.unknownWorkspace,
            chipName: chipMap.get(run.chip_id)?.name ?? messages.chipRuns.unknownChip,
          }));
        }),
      );

      setRuns(
        batches
          .flat()
          .sort((a, b) => b.created_at.localeCompare(a.created_at)),
      );
    } catch (error) {
      toastError(messages.workspace.loadError, error);
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }, [messages]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeCount = useMemo(
    () => runs.filter((run) => ACTIVE.has(run.status)).length,
    [runs],
  );

  useEffect(() => {
    if (activeCount === 0) return;
    const timer = window.setInterval(() => {
      void refresh({ silent: true });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [activeCount, refresh]);

  async function openLog(runId: string) {
    try {
      const response = await chipApi.getRunLogs(runId);
      setLogId(runId);
      setLogText(response.text || messages.empty.logs);
    } catch (error) {
      toastError(messages.errors.list, error);
    }
  }

  return (
    <PageShell>
      <PageHeader
        iconName="jobs"
        eyebrow={messages.chipRuns.eyebrow}
        title={messages.chipRuns.title}
        description={messages.chipRuns.description}
        actions={
          <Button type="button" variant="secondary" disabled={loading} onClick={() => void refresh()}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {messages.common.refresh}
          </Button>
        }
      />

      <Panel tall>
        <Toolbar>
          <ToolbarGroup>
            <span className="text-[13px] font-semibold">{messages.workspace.recentRuns}</span>
            <span className="text-xs text-text-tertiary">
              {messages.common.cases(runs.length)}
              {activeCount > 0 ? ` · ${messages.workspace.polling}` : ""}
            </span>
          </ToolbarGroup>
        </Toolbar>
        <DataGrid className="min-h-0 flex-1" headers={[...messages.chipRuns.headers]}>
          {loading ? (
            <EmptyGridRow cols={8} text={messages.common.loading} />
          ) : runs.length === 0 ? (
            <EmptyGridRow cols={8} text={messages.empty.queue} />
          ) : (
            runs.map((run) => (
              <GridRow key={run.id}>
                <GridCell>
                  <Link
                    className="truncate font-medium text-accent hover:underline"
                    to={`/workspace/${run.workspace_id}`}
                    title={messages.chipRuns.openWorkspace}
                  >
                    {run.workspaceName}
                  </Link>
                </GridCell>
                <GridCell>{run.chipName}</GridCell>
                <GridCell>
                  <StatusPill value={run.status} />
                </GridCell>
                <GridCell mono muted title={run.input_dataset_id ?? undefined}>
                  {run.input_dataset_id?.slice(0, 8) ?? "—"}
                </GridCell>
                <GridCell mono muted title={run.output_dataset_id ?? undefined}>
                  {run.output_dataset_id?.slice(0, 8) ?? "—"}
                </GridCell>
                <GridCell muted title={run.error_message ?? undefined}>
                  <span className="line-clamp-2">{run.error_message ?? "—"}</span>
                </GridCell>
                <GridCell mono muted>{fmtWhen(run.created_at)}</GridCell>
                <GridCell>
                  <Button type="button" variant="quiet" onClick={() => void openLog(run.id)}>
                    <ScrollText className="size-3.5" aria-hidden="true" />
                    {messages.chipRuns.viewLog}
                  </Button>
                </GridCell>
              </GridRow>
            ))
          )}
        </DataGrid>
      </Panel>

      <LogDialog
        open={Boolean(logId)}
        title={`${messages.chipRuns.viewLog} · ${logId?.slice(0, 8) ?? ""}`}
        text={logText}
        icon={<History className="size-4 text-accent" aria-hidden="true" />}
        onClose={() => {
          setLogId(null);
          setLogText("");
        }}
      />
    </PageShell>
  );
}
