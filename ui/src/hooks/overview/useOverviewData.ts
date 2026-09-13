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
    void Promise.all([
      systemApi.getHealth(),
      workspaceApi.list(),
      chipApi.listCatalog(),
      datasetApi.list(),
      connectionApi.getConnections(),
    ])
      .then(async ([health, workspaces, catalog, datasets, connections]) => {
        const chipMap = new Map(catalog.chips.map((chip) => [chip.id, chip.name]));
        const mineWorkspaces = workspaces.workspaces.filter((workspace) =>
          ownedBy(workspace.owner_user_id, user?.id),
        );
        const mineWorkspaceIds = new Set(mineWorkspaces.map((workspace) => workspace.id));
        const batches = await Promise.all(
          workspaces.workspaces.map(async (workspace) => {
            const [placed, runs] = await Promise.all([
              chipApi.list(workspace.id).then((response) => response.chips).catch(() => []),
              chipApi.listRuns(workspace.id).catch(() => ({ runs: [], workspace_runs: [] })),
            ]);
            return {
              placed,
              chips: runs.runs.map((run) => ({
                ...run,
                chipName: chipMap.get(run.chip_id) ?? messages.chipRuns.unknownChip,
              })),
              workspaces: runs.workspace_runs,
            };
          }),
        );
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
      })
      .catch((error) => toastError(messages.errors.overview, error));
  }, [messages, user?.id]);

  return {
    systemHealth,
    chipRuns,
    workspaceRuns,
    mineAssets,
    sharedAssets,
  };
}
