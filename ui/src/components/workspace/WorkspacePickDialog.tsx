import { useEffect, useState } from "react";
import { FolderTree } from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { Button } from "@/components/ui/button";
import { WorkspaceTreePicker } from "@/components/workspace/WorkspaceTreePicker";
import { useLanguage } from "@/i18n/LanguageProvider";
import { toastError } from "@/lib/notifications";
import { workspaceApi } from "@/services/workspace/workspaceApi";
import type { Workspace, WorkspaceFolder } from "@/types/workspace";

export function WorkspacePickDialog({
  open,
  value,
  onChange,
  onClose,
  onConfirm,
}: {
  open: boolean;
  value: string;
  onChange: (workspaceId: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { messages } = useLanguage();
  const [folders, setFolders] = useState<WorkspaceFolder[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const selected = workspaces.some((workspace) => workspace.id === value);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.all([workspaceApi.listFolders(), workspaceApi.list()])
      .then(([folderResponse, workspaceResponse]) => {
        if (cancelled) return;
        setFolders(folderResponse.folders);
        setWorkspaces(workspaceResponse.workspaces);
      })
      .catch((error) => {
        if (!cancelled) toastError(messages.errors.workspace, error);
      });
    return () => {
      cancelled = true;
    };
  }, [messages, open]);

  return (
    <AppDialog
      open={open}
      title={messages.workspace.pickSaveTitle}
      icon={<FolderTree className="size-4 text-accent" aria-hidden="true" />}
      zIndex={140}
      className="h-[min(40rem,88vh)] w-[min(38rem,94vw)]"
      minHeight={420}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {messages.common.cancel}
          </Button>
          <Button type="button" variant="primary" disabled={!selected} onClick={onConfirm}>
            {messages.workspace.pickSaveConfirm}
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <p className="text-[12px] text-text-secondary">{messages.workspace.pickSaveHint}</p>
        <WorkspaceTreePicker
          folders={folders}
          workspaces={workspaces}
          value={value}
          className="min-h-0 flex-1"
          onChange={onChange}
        />
      </div>
    </AppDialog>
  );
}
