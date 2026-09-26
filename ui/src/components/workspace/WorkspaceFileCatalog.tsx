import { ReactNode, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AppWindow, Check, ChevronRight, FileSpreadsheet, Folder, FolderOpen, FolderTree, Search } from "lucide-react";
import { PaneHeader } from "@/components/ui/pane-header";
import {
  type CatalogFile,
  fileCountForFolder,
  filesForWorkspace,
  filterCatalogTree,
  type FileTreeSelection,
} from "@/features/workspace/fileWorkspaceTree";
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

export function WorkspaceFileCatalog({
  folders,
  workspaces,
  files,
  selection,
  onSelect,
  onFileClick,
  activeFileId,
}: {
  folders: WorkspaceFolder[];
  workspaces: Workspace[];
  files: CatalogFile[];
  selection: FileTreeSelection;
  onSelect: (selection: FileTreeSelection) => void;
  onFileClick?: (fileId: string) => void;
  activeFileId?: string | null;
}) {
  const { messages } = useLanguage();
  const [query, setQuery] = useState("");
  const [treeOpen, setTreeOpen] = useState<Record<string, boolean>>({});
  const tree = useMemo(() => filterCatalogTree(folders, workspaces, query), [folders, query, workspaces]);
  const selectedFolderId = selection.type === "folder" ? selection.id : null;
  const selectedWorkspace = selection.type === "workspace"
    ? workspaces.find((workspace) => workspace.id === selection.id) ?? null
    : null;

  useEffect(() => {
    const folderId = selectedFolderId ?? selectedWorkspace?.folder_id ?? null;
    if (!folderId && !selectedWorkspace) return;
    setTreeOpen((current) => ({
      ...current,
      ...ancestorOpenMap(folders, folderId),
      ...(selectedWorkspace ? { [`ws:${selectedWorkspace.id}`]: true } : {}),
    }));
  }, [folders, selectedFolderId, selectedWorkspace]);

  useEffect(() => {
    if (!query.trim()) return;
    setTreeOpen((current) => ({ ...current, ...tree.openIds }));
  }, [query, tree.openIds]);

  const rootFolders = useMemo(
    () =>
      tree.folders
        .filter((folder) => !folder.parent_id)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [tree.folders],
  );
  const rootWorkspaces = useMemo(
    () =>
      tree.workspaces
        .filter((workspace) => !workspace.folder_id)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [tree.workspaces],
  );

  function childFolders(parent: string) {
    return tree.folders
      .filter((folder) => folder.parent_id === parent)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function childWorkspaces(folderId: string | null) {
    return tree.workspaces
      .filter((workspace) =>
        folderId ? workspace.folder_id === folderId : !workspace.folder_id,
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function renderFileNode(file: CatalogFile): ReactNode {
    const active = file.id === activeFileId;
    return (
      <button
        key={file.id}
        type="button"
        className={cn(
          "flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[12px] outline-none transition-colors",
          active ? "bg-accent-subtle text-accent" : "text-text-secondary hover:bg-subtle hover:text-text",
        )}
        onClick={() => onFileClick?.(file.id)}
      >
        <FileSpreadsheet className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{file.name}</span>
      </button>
    );
  }

  function renderWorkspaceNode(workspace: Workspace): ReactNode {
    const active = selection.type === "workspace" && selection.id === workspace.id;
    const nestedFiles = filesForWorkspace(files, workspace.id);
    const openKey = `ws:${workspace.id}`;
    const openNode = Boolean(treeOpen[openKey]);
    return (
      <div key={workspace.id} className="min-w-0">
        <div className="flex min-w-0 items-center">
          <button
            type="button"
            className="grid size-7 shrink-0 place-items-center rounded-md text-text-tertiary outline-none hover:bg-subtle"
            aria-expanded={openNode}
            aria-label={openNode ? messages.workspace.collapseFolder : messages.workspace.expandFolder}
            onClick={() =>
              setTreeOpen((current) => ({ ...current, [openKey]: !current[openKey] }))
            }
          >
            <motion.span
              className={cn("grid place-items-center", nestedFiles.length === 0 && "opacity-0")}
              animate={{ rotate: openNode ? 90 : 0 }}
              transition={{ duration: 0.18 }}
              aria-hidden="true"
            >
              <ChevronRight className="size-3.5" />
            </motion.span>
          </button>
          <button
            type="button"
            className={cn(
              "flex h-9 min-w-0 flex-1 items-center gap-2 rounded-xl px-1.5 text-left outline-none transition-colors",
              active ? "bg-accent-subtle text-accent" : "text-text hover:bg-subtle",
            )}
            aria-current={active ? "true" : undefined}
            onClick={() => onSelect({ type: "workspace", id: workspace.id })}
          >
            <span
              className={cn(
                "grid size-7 shrink-0 place-items-center rounded-lg border",
                active ? "border-accent/25 bg-surface text-accent" : "border-border bg-subtle text-text-secondary",
              )}
            >
              <AppWindow className="size-3.5" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px]">{workspace.name}</span>
            <span className="rounded-full bg-subtle px-2 py-0.5 text-[10px] tabular-nums text-text-tertiary">
              {nestedFiles.length}
            </span>
            {active ? <Check className="size-3.5 shrink-0 text-accent" aria-hidden="true" /> : null}
          </button>
        </div>
        <AnimatePresence initial={false}>
          {openNode && nestedFiles.length > 0 ? (
            <motion.div
              className="overflow-hidden"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: "easeInOut" }}
            >
              <div className="ml-[18px] space-y-0.5 border-l border-border/80 py-1 pl-[18px]">
                {nestedFiles.map((file) => renderFileNode(file))}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    );
  }

  function renderFolderNode(folder: WorkspaceFolder): ReactNode {
    const openNode = Boolean(treeOpen[folder.id]);
    const nestedFolders = childFolders(folder.id);
    const nestedWorkspaces = childWorkspaces(folder.id);
    const hasChildren = nestedFolders.length > 0 || nestedWorkspaces.length > 0;
    const active = selection.type === "folder" && selection.id === folder.id;
    const count = fileCountForFolder(files, folders, workspaces, folder.id);

    return (
      <div key={folder.id} className="min-w-0">
        <div className="flex min-w-0 items-center">
          <button
            type="button"
            className="grid size-7 shrink-0 place-items-center rounded-md text-text-tertiary outline-none hover:bg-subtle"
            aria-expanded={openNode}
            aria-label={openNode ? messages.workspace.collapseFolder : messages.workspace.expandFolder}
            onClick={() =>
              setTreeOpen((current) => ({ ...current, [folder.id]: !current[folder.id] }))
            }
          >
            <motion.span
              className={cn("grid place-items-center", !hasChildren && "opacity-0")}
              animate={{ rotate: openNode ? 90 : 0 }}
              transition={{ duration: 0.18 }}
              aria-hidden="true"
            >
              <ChevronRight className="size-3.5" />
            </motion.span>
          </button>
          <button
            type="button"
            className={cn(
              "flex h-9 min-w-0 flex-1 items-center gap-2 rounded-xl px-1.5 text-left outline-none transition-colors",
              active ? "bg-accent-subtle text-accent" : "text-text hover:bg-subtle",
            )}
            aria-current={active ? "true" : undefined}
            onClick={() => onSelect({ type: "folder", id: folder.id })}
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-warning-subtle text-warning" aria-hidden="true">
              {openNode ? <FolderOpen className="size-4" /> : <Folder className="size-4" />}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{folder.name}</span>
            <span className="rounded-full bg-subtle px-2 py-0.5 text-[10px] font-normal tabular-nums text-text-tertiary">
              {count}
            </span>
          </button>
        </div>
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
                {nestedFolders.map((child) => renderFolderNode(child))}
                {nestedWorkspaces.map((workspace) => renderWorkspaceNode(workspace))}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    );
  }

  const allActive = selection.type === "all";

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden bg-surface">
      <PaneHeader
        title={messages.workspace.browser}
        meta={String(files.length)}
      />
      <div className="shrink-0 border-b border-border p-2">
        <label className="group flex h-8 items-center overflow-hidden rounded-lg border border-border bg-surface focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
          <span className="grid size-8 shrink-0 place-items-center text-text-tertiary group-focus-within:text-accent">
            <Search className="size-3.5" aria-hidden="true" />
          </span>
          <input
            type="search"
            className="min-w-0 flex-1 bg-transparent pr-2 text-[12px] text-text outline-none placeholder:text-text-tertiary"
            value={query}
            placeholder={messages.workspace.searchWorkspace}
            aria-label={messages.workspace.searchWorkspace}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <div className="scroll-pane min-h-0 flex-1 overflow-y-auto bg-surface p-2">
        <button
          type="button"
          className={cn(
            "mb-1 flex h-9 w-full items-center gap-2 rounded-xl px-2 text-left text-[12px] font-medium outline-none transition-colors",
            allActive ? "bg-accent-subtle text-accent" : "text-text hover:bg-subtle",
          )}
          aria-current={allActive ? "true" : undefined}
          onClick={() => onSelect({ type: "all" })}
        >
          <span className="grid size-7 place-items-center rounded-lg bg-accent-subtle text-accent">
            <FolderTree className="size-3.5" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1 truncate">{messages.workspace.fileCatalogAll}</span>
          <span className="rounded-full bg-subtle px-2 py-0.5 text-[10px] tabular-nums text-text-tertiary">
            {files.length}
          </span>
        </button>
        {rootFolders.length === 0 && rootWorkspaces.length === 0 ? (
          <p className="px-3 py-8 text-center text-[12px] text-text-tertiary">
            {query.trim() ? messages.workspace.noWorkspaceResults : messages.workspace.noWorkspaces}
          </p>
        ) : (
          <div className="space-y-0.5">
            {rootFolders.map((folder) => renderFolderNode(folder))}
            {rootWorkspaces.map((workspace) => renderWorkspaceNode(workspace))}
          </div>
        )}
      </div>
    </aside>
  );
}
