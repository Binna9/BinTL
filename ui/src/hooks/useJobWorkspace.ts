import { useCallback, useEffect, useState } from "react";
import { connectionApi } from "@/services/connectionApi";
import { extractApi } from "@/services/extractApi";
import { fileApi } from "@/services/fileApi";
import { jobApi } from "@/services/jobApi";
import { useLanguage } from "@/i18n/LanguageProvider";
import type { DataConnection } from "@/types/connection";
import type { ExtractRecord } from "@/types/extract";
import type { StoredFile } from "@/types/file";
import type { EtlJob } from "@/types/job";

export function useJobWorkspace() {
  const { messages } = useLanguage();
  const [jobs, setJobs] = useState<EtlJob[]>([]);
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [extracts, setExtracts] = useState<ExtractRecord[]>([]);
  const [connections, setConnections] = useState<DataConnection[]>([]);
  const [workspaceError, setWorkspaceError] = useState("");

  const refreshJobWorkspace = useCallback(async () => {
    const [jobResponse, fileResponse, extractResponse, connectionResponse] =
      await Promise.all([
        jobApi.getJobs(50),
        fileApi.getFiles(),
        extractApi.getExtracts(50),
        connectionApi.getConnections(),
      ]);
    setJobs(jobResponse.jobs);
    setFiles(fileResponse.files);
    setExtracts(
      extractResponse.extracts.filter((extract) => extract.status === "succeeded"),
    );
    setConnections(connectionResponse.connections);
  }, []);

  useEffect(() => {
    void refreshJobWorkspace().catch((error) =>
      setWorkspaceError(
        error instanceof Error ? error.message : messages.errors.workspace,
      ),
    );
  }, [refreshJobWorkspace, messages]);

  return {
    jobs,
    files,
    extracts,
    connections,
    workspaceError,
    setWorkspaceError,
    refreshJobWorkspace,
  };
}
