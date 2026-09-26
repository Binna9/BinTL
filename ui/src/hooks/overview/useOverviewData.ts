import { useEffect, useState } from "react";
import { connectionApi } from "@/services/connections/connectionApi";
import { datasetApi } from "@/services/transform/datasetApi";
import { systemApi } from "@/services/overview/systemApi";
import { chipApi } from "@/services/chips/chipApi";
import { workspaceApi } from "@/services/workspace/workspaceApi";
import { useLanguage } from "@/i18n/LanguageProvider";
import { useSession } from "@/hooks/auth/useSession";
import { toastError } from "@/lib/notifications";
import type { ChipRunRow } from "@/components/overview/model";
import type { AssetCounts } from "@/components/overview/types";
import type { WorkspaceExecution } from "@/types/chip";
import type { SystemHealth } from "@/types/system";

const EMPTY_ASSETS: AssetCounts = { workspaces: 0, chips: 0, datasets: 0, connections: 0 };

function ownedBy(owner: string | null | undefined, userId: string | undefined) {
  return !userId || !owner || owner === userId;
}

export function useOverviewData() {
  const { messages } = useLanguage();
  const { user } = useSession();
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null);
  const [chipRuns, setChipRuns] = useState<ChipRunRow[]>([]);
  const [workspaceRuns, setWorkspaceRuns] = useState<WorkspaceExecution[]>([]);
  const [mineAssets, setMineAssets] = useState<AssetCounts>(EMPTY_ASSETS);
  const [sharedAssets, setSharedAssets] = useState<AssetCounts>(EMPTY_ASSETS);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;

    const refresh = async (options?: { silent?: boolean }) => {
      const silent = options?.silent ? { silent: true as const } : undefined;
      const [health, workspaces, catalog, datasets, connections] = await Promise.all([
        systemApi.getHealth(silent),
        workspaceApi.list(silent),
        chipApi.listCatalog(silent),
        datasetApi.list(silent),
        connectionApi.getConnections(silent),
      ]);
      const chipMap = new Map(catalog.chips.map((chip) => [chip.id, chip.name]));
      const mineWorkspaces = workspaces.workspaces.filter((workspace) =>
        ownedBy(workspace.owner_user_id, user?.id),
      );
      const mineWorkspaceIds = new Set(mineWorkspaces.map((workspace) => workspace.id));
      const batches = await Promise.all(
        workspaces.workspaces.map(async (workspace) => {
          const runs = await chipApi.listRuns(workspace.id, silent).catch(() => ({
            runs: [],
            workspace_runs: [],
          }));
          return {
            chips: runs.runs.map((run) => ({
              ...run,
              chipName: chipMap.get(run.chip_id) ?? messages.chipRuns.unknownChip,
            })),
            workspaces: runs.workspace_runs,
          };
        }),
      );
      if (stopped) return;
      setSystemHealth(health);
      setMineAssets({
        workspaces: mineWorkspaces.length,
        chips: catalog.chips.filter((chip) => chip.active).length,
        datasets: datasets.datasets.filter((dataset) => mineWorkspaceIds.has(dataset.workspace_id)).length,
        connections: 0,
      });
      setSharedAssets({
        ...EMPTY_ASSETS,
        connections: connections.connections.length,
      });
      setChipRuns(batches.flatMap((batch) => batch.chips));
      setWorkspaceRuns(batches.flatMap((batch) => batch.workspaces));
    };

    const poll = async (silent: boolean) => {
      try {
        await refresh({ silent });
      } catch (error) {
        if (!silent && !stopped) toastError(messages.errors.overview, error);
      }
      if (!stopped) timer = window.setTimeout(() => void poll(true), 2000);
    };
    void poll(false);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [messages, user?.id]);

  return {
    systemHealth,
    chipRuns,
    workspaceRuns,
    mineAssets,
    sharedAssets,
  };
}
