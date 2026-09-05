import { ReactNode, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AppWindow, ArrowRight, Check, ChevronRight, Folder, FolderOpen, FolderTree } from "lucide-react";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import type { Workspace, WorkspaceFolder } from "@/types/workspace";

function ancestorOpenMap(folders: WorkspaceFolder[], folderId: string | null) {
  const open: Record<string, boolean> = {};
  let cursor = folderId;
  while (cursor) {
    open[cursor] = true;
    cursor = folders.find((folder) => folder.id === cursor)?.parent_id ?? null;
  }
  return open;
}

function workspacePathLabel(
  folders: WorkspaceFolder[],
  workspace: Workspace,
  topLabel: string,
) {
  if (!workspace.folder_id) return `${topLabel} / ${workspace.name}`;
  const parts: string[] = [];
  let cursor: string | null = workspace.folder_id;
  while (cursor) {
    const folder = folders.find((item) => item.id === cursor);
    if (!folder) break;
    parts.unshift(folder.name);
    cursor = folder.parent_id;
  }
  const prefix = parts.length > 0 ? parts.join(" / ") : topLabel;
  return `${prefix} / ${workspace.name}`;
}

export function WorkspaceTreePicker({
  folders,
  workspaces,
  value,
  onChange,
  className,
  showSelectionPath = true,
}: {
  folders: WorkspaceFolder[];
  workspaces: Workspace[];
  value: string;
  onChange: (workspaceId: string) => void;
  className?: string;
  showSelectionPath?: boolean;
}) {
  const { messages } = useLanguage();
  const selected = workspaces.find((workspace) => workspace.id === value) ?? null;
  const [treeOpen, setTreeOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!selected) return;
    setTreeOpen((current) => ({
      ...current,
      ...ancestorOpenMap(folders, selected.folder_id ?? null),
    }));
  }, [folders, selected]);

  const rootFolders = useMemo(
    () =>
      folders
        .filter((folder) => !folder.parent_id)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [folders],
  );
  const rootWorkspaces = useMemo(
    () =>
      workspaces
        .filter((workspace) => !workspace.folder_id)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [workspaces],
  );

  function childFolders(parent: string) {
    return folders
      .filter((folder) => folder.parent_id === parent)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function childWorkspaces(folderId: string | null) {
    return workspaces
      .filter((workspace) =>
        folderId ? workspace.folder_id === folderId : !workspace.folder_id,
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function renderWorkspaceNode(workspace: Workspace): ReactNode {
    const active = workspace.id === value;
    return (
      <button
        key={workspace.id}
        type="button"
        className={cn(
          "group flex h-10 w-full min-w-0 items-center gap-2.5 rounded-xl border px-2.5 text-left outline-none transition-all",
          active
            ? "border-accent/30 bg-accent-subtle text-accent shadow-sm"
            : "border-transparent text-text hover:border-border hover:bg-surface hover:shadow-sm",
        )}
        aria-current={active ? "true" : undefined}
        onClick={() => onChange(workspace.id)}
      >
        <span className={cn(
          "grid size-7 shrink-0 place-items-center rounded-lg border",
          active ? "border-accent/25 bg-surface text-accent" : "border-border bg-subtle text-text-secondary",
        )}>
          <AppWindow className="size-3.5" aria-hidden="true" />
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[13px]",
            active ? "font-medium text-accent" : "text-text",
          )}
        >
          {workspace.name}
        </span>
        {active ? (
          <Check className="size-4 shrink-0 text-accent" aria-hidden="true" />
        ) : (
          <ArrowRight className="size-3.5 shrink-0 text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
        )}
      </button>
    );
  }

  function renderFolderNode(folder: WorkspaceFolder, depth = 0): ReactNode {
    const openNode = Boolean(treeOpen[folder.id]);
    const nestedFolders = childFolders(folder.id);
    const nestedWorkspaces = childWorkspaces(folder.id);
    const hasChildren = nestedFolders.length > 0 || nestedWorkspaces.length > 0;

    return (
      <div key={folder.id} className="min-w-0">
        <button
          type="button"
          className="group flex h-9 w-full min-w-0 items-center gap-2 rounded-xl px-2 text-left text-[12px] font-medium text-text outline-none transition-colors hover:bg-subtle"
          aria-expanded={openNode}
          onClick={() =>
            setTreeOpen((current) => ({ ...current, [folder.id]: !current[folder.id] }))
          }
        >
          <motion.span
            className={cn("grid size-5 shrink-0 place-items-center rounded-md text-text-tertiary group-hover:bg-surface", !hasChildren && "opacity-0")}
            animate={{ rotate: openNode ? 90 : 0 }}
            transition={{ duration: 0.18 }}
            aria-hidden="true"
          >
            <ChevronRight className="size-3.5" />
          </motion.span>
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-warning-subtle text-warning" aria-hidden="true">
            {openNode ? <FolderOpen className="size-4" /> : <Folder className="size-4" />}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">{folder.name}</span>
          <span className="rounded-full bg-subtle px-2 py-0.5 text-[10px] font-normal tabular-nums text-text-tertiary">
            {nestedFolders.length + nestedWorkspaces.length}
          </span>
        </button>
        <AnimatePresence initial={false}>
          {openNode && hasChildren ? (
            <motion.div
              className="overflow-hidden"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: "easeInOut" }}
            >
              <div className="ml-[18px] space-y-0.5 border-l border-border/80 py-1 pl-[18px]">
                {nestedFolders.map((child) => renderFolderNode(child, depth + 1))}
                {nestedWorkspaces.map((workspace) => renderWorkspaceNode(workspace))}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-col gap-3", className)}>
      {showSelectionPath && selected ? (
        <p className="rounded-lg bg-subtle px-2.5 py-1.5 text-[11px] text-text-secondary">
          <span className="font-medium text-text">{messages.workspace.createLocation}: </span>
          {workspacePathLabel(folders, selected, messages.workspace.topLevel)}
        </p>
      ) : showSelectionPath ? (
        <p className="text-[11px] text-text-tertiary">{messages.workspace.selectWorkspace}</p>
      ) : null}
      <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div className="flex items-center justify-between border-b border-border bg-subtle/55 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-xl bg-accent-subtle text-accent">
              <FolderTree className="size-4" aria-hidden="true" />
            </span>
            <div>
              <p className="text-[12px] font-semibold text-text">{messages.workspace.workspaceTreeTitle}</p>
              <p className="text-[10px] text-text-tertiary">{messages.workspace.workspaceTreeHint}</p>
            </div>
          </div>
          <span className="rounded-full border border-border bg-surface px-2.5 py-1 text-[10px] font-medium tabular-nums text-text-secondary">
            {workspaces.length}
          </span>
        </div>
        <div className="scroll-pane max-h-[360px] min-h-56 overflow-y-auto bg-gradient-to-b from-surface to-subtle/20 p-3">
        {rootFolders.length === 0 && rootWorkspaces.length === 0 ? (
          <p className="px-3 py-8 text-center text-[12px] text-text-tertiary">{messages.workspace.noWorkspaces}</p>
        ) : (
          <div className="space-y-1">
            {rootFolders.map((folder) => renderFolderNode(folder))}
            {rootWorkspaces.map((workspace) => (
              <div key={workspace.id}>
                {renderWorkspaceNode(workspace)}
              </div>
            ))}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
