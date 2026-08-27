import { useEffect, useState } from "react";
import { connectionApi } from "@/services/connectionApi";
import { datasetApi } from "@/services/datasetApi";
import { extractApi } from "@/services/extractApi";
import { jobApi } from "@/services/jobApi";
import { systemApi } from "@/services/systemApi";
import { chipApi } from "@/services/chipApi";
import { workspaceApi } from "@/services/workspaceApi";
import { useLanguage } from "@/i18n/LanguageProvider";
import { toastError } from "@/lib/notifications";
import type { ExtractRecord } from "@/types/extract";
import type { EtlJob } from "@/types/job";
import type { SystemHealth } from "@/types/system";

export function useOverviewData() {
  const { messages } = useLanguage();
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null);
  const [recentJobs, setRecentJobs] = useState<EtlJob[]>([]);
  const [recentExtracts, setRecentExtracts] = useState<ExtractRecord[]>([]);
  const [workspaceCount, setWorkspaceCount] = useState(0);
  const [activeChipCount, setActiveChipCount] = useState(0);
  const [datasetCount, setDatasetCount] = useState(0);
  const [connectionCount, setConnectionCount] = useState(0);

  useEffect(() => {
    void Promise.all([
      systemApi.getHealth(),
      jobApi.getJobs(80),
      extractApi.getExtracts(80),
      workspaceApi.list(),
      datasetApi.list(),
      connectionApi.getConnections(),
    ])
      .then(async ([health, jobs, extracts, workspaces, datasets, connections]) => {
        setSystemHealth(health);
        setRecentJobs(jobs.jobs);
        setRecentExtracts(extracts.extracts);
        setWorkspaceCount(workspaces.workspaces.length);
        setDatasetCount(datasets.datasets.length);
        setConnectionCount(connections.connections.length);
        const taskLists = await Promise.all(
          workspaces.workspaces.map((workspace) =>
            chipApi.list(workspace.id).then((response) => response.chips).catch(() => []),
          ),
        );
        setActiveChipCount(taskLists.flat().filter((chip) => chip.active).length);
      })
      .catch((error) => toastError(messages.errors.overview, error));
  }, [messages]);

  return {
    systemHealth,
    recentJobs,
    recentExtracts,
    workspaceCount,
    activeChipCount,
    datasetCount,
    connectionCount,
  };
}
