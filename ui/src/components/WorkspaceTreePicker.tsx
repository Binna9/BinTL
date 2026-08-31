import { ReactNode, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AppWindow, ChevronDown, Folder, FolderOpen } from "lucide-react";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { selectableClass } from "@/lib/selectable";
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
}: {
  folders: WorkspaceFolder[];
  workspaces: Workspace[];
  value: string;
  onChange: (workspaceId: string) => void;
  className?: string;
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
          "flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none",
          selectableClass(active),
        )}
        aria-current={active ? "true" : undefined}
        onClick={() => onChange(workspace.id)}
      >
        <AppWindow
          className={cn("size-3.5 shrink-0", active ? "text-accent" : "text-text-secondary")}
          aria-hidden="true"
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[12px]",
            active ? "font-medium text-accent" : "text-text",
          )}
        >
          {workspace.name}
        </span>
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
          className="flex w-full min-w-0 items-center gap-1.5 rounded-lg px-1 py-1 text-left text-[12px] text-text outline-none hover:bg-subtle"
          style={{ paddingLeft: 8 + depth * 12 }}
          aria-expanded={openNode}
          onClick={() =>
            setTreeOpen((current) => ({ ...current, [folder.id]: !current[folder.id] }))
          }
        >
          <motion.span
            className={cn("grid size-3.5 shrink-0 place-items-center text-text-tertiary", !hasChildren && "opacity-0")}
            animate={{ rotate: openNode ? 180 : 0 }}
            transition={{ duration: 0.18 }}
            aria-hidden="true"
          >
            <ChevronDown className="size-3.5" />
          </motion.span>
          <span className="size-3.5 shrink-0 text-text-secondary" aria-hidden="true">
            {openNode ? <FolderOpen className="size-3.5" /> : <Folder className="size-3.5" />}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">{folder.name}</span>
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
              <div className="space-y-0.5 py-0.5" style={{ paddingLeft: 20 + depth * 12 }}>
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
    <div className={cn("flex min-h-0 flex-col gap-2", className)}>
      {selected ? (
        <p className="rounded-lg bg-subtle px-2.5 py-1.5 text-[11px] text-text-secondary">
          <span className="font-medium text-text">{messages.workspace.createLocation}: </span>
          {workspacePathLabel(folders, selected, messages.workspace.topLevel)}
        </p>
      ) : (
        <p className="text-[11px] text-text-tertiary">{messages.workspace.selectWorkspace}</p>
      )}
      <div className="scroll-pane max-h-56 min-h-40 overflow-y-auto rounded-xl border border-border bg-subtle/30 p-2">
        {rootFolders.length === 0 && rootWorkspaces.length === 0 ? (
          <p className="px-2 py-3 text-[12px] text-text-tertiary">{messages.workspace.noWorkspaces}</p>
        ) : (
          <div className="space-y-0.5">
            {rootFolders.map((folder) => renderFolderNode(folder))}
            {rootWorkspaces.map((workspace) => (
              <div key={workspace.id} className="pl-1">
                {renderWorkspaceNode(workspace)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
