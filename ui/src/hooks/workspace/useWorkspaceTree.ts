import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/i18n/LanguageProvider";
import { toastError } from "@/lib/notifications";
import { workspaceApi } from "@/services/workspace/workspaceApi";
import type { Workspace, WorkspaceFolder } from "@/types/workspace";

export function useWorkspaceTree() {
  const { messages } = useLanguage();
  const [folders, setFolders] = useState<WorkspaceFolder[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);

  const refresh = useCallback(async () => {
    const [folderResponse, workspaceResponse] = await Promise.all([
      workspaceApi.listFolders(),
      workspaceApi.list(),
    ]);
    setFolders(folderResponse.folders);
    setWorkspaces(workspaceResponse.workspaces);
  }, []);

  useEffect(() => {
    void refresh().catch((error) => toastError(messages.errors.workspace, error));
  }, [messages, refresh]);

  return { folders, workspaces, refresh };
}
