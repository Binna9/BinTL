import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AppWindow,
  ChevronDown,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
} from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { SplitLayout } from "@/components/SplitLayout";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { showConfirm } from "@/lib/notifications";
import { workspaceApi } from "@/services/workspaceApi";
import type { Workspace, WorkspaceFolder } from "@/types/workspace";

type Editor =
  | { mode: "create-folder"; parentId: string | null }
  | { mode: "create-workspace"; parentId: string | null }
  | { mode: "edit-folder"; id: string }
  | { mode: "edit-workspace"; id: string };

function folderPathLabel(
  folders: WorkspaceFolder[],
  parentId: string | null,
  topLabel: string,
) {
  if (!parentId) return topLabel;
  const parts: string[] = [];
  let cursor: string | null = parentId;
  while (cursor) {
    const folder = folders.find((item) => item.id === cursor);
    if (!folder) break;
    parts.unshift(folder.name);
    cursor = folder.parent_id;
  }
  return parts.length > 0 ? parts.join(" / ") : topLabel;
}

function folderNameTaken(
  folders: WorkspaceFolder[],
  name: string,
  parentId: string | null,
  exceptId?: string,
) {
  const needle = name.trim().toLowerCase();
  return folders.some(
    (folder) =>
      folder.id !== exceptId &&
      (folder.parent_id ?? null) === parentId &&
      folder.name.trim().toLowerCase() === needle,
  );
}

function workspaceNameTaken(
  workspaces: Workspace[],
  name: string,
  exceptId?: string,
) {
  const needle = name.trim().toLowerCase();
  return workspaces.some(
    (workspace) =>
      workspace.id !== exceptId &&
      workspace.name.trim().toLowerCase() === needle,
  );
}

function ancestorOpenMap(folders: WorkspaceFolder[], folderId: string | null) {
  const open: Record<string, boolean> = {};
  let cursor = folderId;
  while (cursor) {
    open[cursor] = true;
    cursor = folders.find((folder) => folder.id === cursor)?.parent_id ?? null;
  }
  return open;
}

function isFolderDescendant(
  folders: WorkspaceFolder[],
  candidateId: string,
  ancestorId: string,
) {
  let cursor: string | null = candidateId;
  let guard = 0;
  while (cursor) {
    if (cursor === ancestorId) return true;
    if (++guard > 64) return true;
    cursor = folders.find((folder) => folder.id === cursor)?.parent_id ?? null;
  }
  return false;
}

export function WorkspaceManageDialog({
  open,
  folders,
  workspaces,
  focusFolderId,
  currentWorkspaceId,
  onClose,
  onFoldersChange,
  onWorkspacesChange,
  onOpenWorkspace,
}: {
  open: boolean;
  folders: WorkspaceFolder[];
  workspaces: Workspace[];
  focusFolderId: string | null;
  currentWorkspaceId?: string;
  onClose: () => void;
  onFoldersChange: (folders: WorkspaceFolder[]) => void;
  onWorkspacesChange: (workspaces: Workspace[]) => void;
  onOpenWorkspace: (workspaceId: string) => void;
}) {
  const { messages } = useLanguage();
  const [treeOpen, setTreeOpen] = useState<Record<string, boolean>>({});
  const [editor, setEditor] = useState<Editor | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) {
      setEditor(null);
      setError("");
      setBusy(false);
      return;
    }
    setTreeOpen(ancestorOpenMap(folders, focusFolderId));
  }, [open, focusFolderId, folders]);

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

  function selectParent(next: string | null) {
    if (!editor) return;
    if (
      editor.mode === "edit-folder" &&
      next &&
      (next === editor.id || isFolderDescendant(folders, next, editor.id))
    ) {
      setError(messages.workspace.folderMoveIntoSelf);
      return;
    }
    setParentId(next);
    if (error) setError("");
  }

  function startCreateFolder(under: string | null) {
    setEditor({ mode: "create-folder", parentId: under });
    setName("");
    setDescription("");
    setParentId(under);
    setError("");
  }

  function startCreateWorkspace(under: string | null) {
    setEditor({ mode: "create-workspace", parentId: under });
    setName("");
    setDescription("");
    setParentId(under);
    setError("");
  }

  function startEditFolder(folder: WorkspaceFolder) {
    setEditor({ mode: "edit-folder", id: folder.id });
    setName(folder.name);
    setDescription("");
    setParentId(folder.parent_id);
    setTreeOpen((current) => ({ ...current, ...ancestorOpenMap(folders, folder.parent_id) }));
    setError("");
  }

  function startEditWorkspace(workspace: Workspace) {
    setEditor({ mode: "edit-workspace", id: workspace.id });
    setName(workspace.name);
    setDescription(workspace.description ?? "");
    setParentId(workspace.folder_id ?? null);
    setTreeOpen((current) => ({
      ...current,
      ...ancestorOpenMap(folders, workspace.folder_id ?? null),
    }));
    setError("");
  }

  function cancelEditor() {
    setEditor(null);
    setError("");
  }

  const editingFolderId = editor?.mode === "edit-folder" ? editor.id : undefined;
  const nameConflict =
    editor?.mode === "create-folder" || editor?.mode === "edit-folder"
      ? folderNameTaken(folders, name, parentId, editingFolderId)
      : editor?.mode === "create-workspace" || editor?.mode === "edit-workspace"
        ? workspaceNameTaken(
            workspaces,
            name,
            editor.mode === "edit-workspace" ? editor.id : undefined,
          )
        : false;

  async function submitEditor(event: FormEvent) {
    event.preventDefault();
    if (!editor || busy) return;
    const trimmed = name.trim();
    if (!trimmed || nameConflict) {
      if (nameConflict) {
        setError(
          editor.mode === "create-folder" || editor.mode === "edit-folder"
            ? messages.workspace.folderNameTaken
            : messages.workspace.workspaceNameTaken,
        );
      }
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (editor.mode === "create-folder") {
        const created = await workspaceApi.createFolder({
          name: trimmed,
          parent_id: parentId,
        });
        onFoldersChange([...folders, created]);
        setTreeOpen((current) => ({
          ...current,
          ...(parentId ? { [parentId]: true } : {}),
          [created.id]: true,
        }));
      } else if (editor.mode === "edit-folder") {
        if (
          parentId &&
          (parentId === editor.id || isFolderDescendant(folders, parentId, editor.id))
        ) {
          setError(messages.workspace.folderMoveIntoSelf);
          return;
        }
        const updated = await workspaceApi.updateFolder(editor.id, {
          name: trimmed,
          parent_id: parentId,
        });
        onFoldersChange(folders.map((folder) => (folder.id === updated.id ? updated : folder)));
      } else if (editor.mode === "create-workspace") {
        const created = await workspaceApi.create({
          name: trimmed,
          description: description.trim() || undefined,
          folder_id: parentId,
        });
        onWorkspacesChange([...workspaces, created]);
        if (parentId) {
          setTreeOpen((current) => ({ ...current, [parentId]: true }));
        }
        onOpenWorkspace(created.id);
      } else {
        const updated = await workspaceApi.update(editor.id, {
          name: trimmed,
          description: description.trim(),
          folder_id: parentId,
        });
        onWorkspacesChange(
          workspaces.map((workspace) => (workspace.id === updated.id ? updated : workspace)),
        );
      }
      cancelEditor();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (message.includes("already exists")) {
        setError(messages.workspace.folderNameTaken);
      } else {
        setError(`${messages.workspace.manageSaveError}: ${message}`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function removeFolder(folder: WorkspaceFolder) {
    const confirmed = await showConfirm(
      messages.workspace.deleteFolderTitle,
      messages.workspace.deleteFolderMessage(folder.name),
      { tone: "danger", confirmLabel: messages.common.delete },
    );
    if (!confirmed) return;
    setBusy(true);
    setError("");
    try {
      await workspaceApi.deleteFolder(folder.id);
      const dropIds = new Set<string>();
      const queue = [folder.id];
      while (queue.length > 0) {
        const id = queue.pop()!;
        dropIds.add(id);
        for (const child of folders) {
          if (child.parent_id === id) queue.push(child.id);
        }
      }
      onFoldersChange(folders.filter((item) => !dropIds.has(item.id)));
      onWorkspacesChange(
        workspaces.map((workspace) =>
          workspace.folder_id && dropIds.has(workspace.folder_id)
            ? { ...workspace, folder_id: null }
            : workspace,
        ),
      );
      if (editor && "id" in editor && dropIds.has(editor.id)) cancelEditor();
      if (parentId && dropIds.has(parentId)) setParentId(null);
    } catch (reason) {
      setError(`${messages.workspace.deleteFolderError}: ${String(reason)}`);
    } finally {
      setBusy(false);
    }
  }

  async function removeWorkspace(workspace: Workspace) {
    const confirmed = await showConfirm(
      messages.workspace.deleteWorkspaceTitle,
      messages.workspace.deleteWorkspaceMessage(workspace.name),
      { tone: "danger", confirmLabel: messages.common.delete },
    );
    if (!confirmed) return;
    setBusy(true);
    setError("");
    try {
      await workspaceApi.delete(workspace.id);
      const next = workspaces.filter((item) => item.id !== workspace.id);
      onWorkspacesChange(next);
      if (editor?.mode === "edit-workspace" && editor.id === workspace.id) cancelEditor();
      if (currentWorkspaceId === workspace.id) {
        onOpenWorkspace(next[0]?.id ?? "");
      }
    } catch (reason) {
      setError(`${messages.workspace.deleteWorkspaceError}: ${String(reason)}`);
    } finally {
      setBusy(false);
    }
  }

  function rowActions(children: ReactNode) {
    return <div className="flex shrink-0 items-center gap-0.5 opacity-80">{children}</div>;
  }

  function iconButton(
    label: string,
    onClick: () => void,
    icon: ReactNode,
    danger = false,
  ) {
    return (
      <button
        type="button"
        className={cn(
          "grid size-6 place-items-center rounded outline-none transition-colors",
          danger
            ? "text-text-tertiary hover:bg-danger-subtle hover:text-danger"
            : "text-text-tertiary hover:bg-canvas hover:text-text",
        )}
        aria-label={label}
        title={label}
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
      >
        {icon}
      </button>
    );
  }

  function renderFolderNode(folder: WorkspaceFolder): ReactNode {
    const openNode = Boolean(treeOpen[folder.id]);
    const nestedFolders = childFolders(folder.id);
    const nestedWorkspaces = childWorkspaces(folder.id);
    const hasChildren = nestedFolders.length > 0 || nestedWorkspaces.length > 0;
    const selected = Boolean(editor) && parentId === folder.id;
    const banned =
      editor?.mode === "edit-folder" &&
      (folder.id === editor.id || isFolderDescendant(folders, folder.id, editor.id));

    return (
      <div key={folder.id} className="min-w-0">
        <div
          className={cn(
            "group flex w-full min-w-0 items-center gap-1 rounded-lg px-1 py-0.5 text-[12px] transition-colors",
            banned
              ? "opacity-40"
              : selected
                ? "bg-accent-subtle font-semibold text-accent hover:bg-accent/15"
                : "text-text hover:bg-subtle",
          )}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-left outline-none"
            aria-expanded={openNode}
            disabled={banned}
            onClick={() => {
              if (editor) {
                selectParent(selected ? null : folder.id);
                return;
              }
              if (hasChildren) {
                setTreeOpen((current) => ({ ...current, [folder.id]: !current[folder.id] }));
              }
            }}
          >
            <span className="size-3.5 shrink-0" aria-hidden="true">
              {openNode ? <FolderOpen className="size-3.5" /> : <Folder className="size-3.5" />}
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">{folder.name}</span>
          </button>
          {hasChildren ? (
            <button
              type="button"
              className="rounded p-1 text-text-tertiary outline-none hover:bg-canvas hover:text-text"
              aria-expanded={openNode}
              aria-label={openNode ? messages.workspace.collapseFolder : messages.workspace.expandFolder}
              onClick={() =>
                setTreeOpen((current) => ({ ...current, [folder.id]: !current[folder.id] }))
              }
            >
              <motion.span
                className="block size-3.5"
                animate={{ rotate: openNode ? 180 : 0 }}
                transition={{ duration: 0.18 }}
                aria-hidden="true"
              >
                <ChevronDown className="size-3.5" />
              </motion.span>
            </button>
          ) : null}
          {rowActions(
            <>
              {iconButton(messages.workspace.newFolder, () => startCreateFolder(folder.id), (
                <FolderPlus className="size-3.5" aria-hidden="true" />
              ))}
              {iconButton(messages.workspace.newWorkspace, () => startCreateWorkspace(folder.id), (
                <AppWindow className="size-3.5" aria-hidden="true" />
              ))}
              {iconButton(messages.common.edit, () => startEditFolder(folder), (
                <Pencil className="size-3.5" aria-hidden="true" />
              ))}
              {iconButton(
                messages.common.delete,
                () => void removeFolder(folder),
                <Trash2 className="size-3.5" aria-hidden="true" />,
                true,
              )}
            </>,
          )}
        </div>
        <AnimatePresence initial={false}>
          {openNode && hasChildren ? (
            <motion.div
              className="overflow-hidden"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeInOut" }}
            >
              <div className="ml-3 space-y-0.5 border-l border-border py-0.5 pl-2">
                {nestedFolders.map((child) => renderFolderNode(child))}
                {nestedWorkspaces.map((workspace) => renderWorkspaceNode(workspace))}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    );
  }

  function renderWorkspaceNode(workspace: Workspace) {
    return (
      <div
        key={workspace.id}
        className="group flex w-full min-w-0 items-center gap-1 rounded-lg px-1 py-0.5 text-[12px] text-text-secondary transition-colors hover:bg-subtle hover:text-text"
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-left outline-none"
          onClick={() => onOpenWorkspace(workspace.id)}
        >
          <AppWindow className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
        </button>
        {rowActions(
          <>
            {iconButton(messages.common.edit, () => startEditWorkspace(workspace), (
              <Pencil className="size-3.5" aria-hidden="true" />
            ))}
            {iconButton(
              messages.common.delete,
              () => void removeWorkspace(workspace),
              <Trash2 className="size-3.5" aria-hidden="true" />,
              true,
            )}
          </>,
        )}
      </div>
    );
  }

  const editorTitle =
    editor?.mode === "create-folder"
      ? messages.workspace.createFolderTitle
      : editor?.mode === "edit-folder"
        ? messages.workspace.editFolderTitle
        : editor?.mode === "create-workspace"
          ? messages.workspace.createWorkspaceTitle
          : editor?.mode === "edit-workspace"
            ? messages.workspace.editWorkspaceTitle
            : "";

  return (
    <AppDialog
      open={open}
      title={messages.workspace.manageTitle}
      icon={<FolderOpen className="size-4 text-accent" aria-hidden="true" />}
      className="h-[min(48rem,92vh)] w-[min(42rem,94vw)]"
      minWidth={420}
      minHeight={400}
      onClose={onClose}
      footer={
        <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
          {messages.common.close}
        </Button>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
        <p className="shrink-0 text-xs text-text-secondary">{messages.workspace.manageHint}</p>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button type="button" disabled={busy} onClick={() => startCreateFolder(null)}>
            <FolderPlus className="size-3.5" aria-hidden="true" />
            {messages.workspace.newFolder}
          </Button>
          <Button type="button" disabled={busy} onClick={() => startCreateWorkspace(null)}>
            <AppWindow className="size-3.5" aria-hidden="true" />
            {messages.workspace.newWorkspace}
          </Button>
        </div>

        {editor ? (
          <SplitLayout
            direction="vertical"
            className="min-h-0 flex-1"
            defaultSizes={[240]}
            defaultRatio={0.55}
            minSize={120}
          >
            <div className="h-full min-h-0 overflow-y-auto rounded-xl border border-border bg-subtle/30 p-2">
              {rootFolders.length === 0 && rootWorkspaces.length === 0 ? (
                <p className="px-2 py-3 text-[12px] text-text-tertiary">{messages.workspace.noWorkspaces}</p>
              ) : (
                <div className="space-y-0.5">
                  {rootFolders.map((folder) => renderFolderNode(folder))}
                  {rootWorkspaces.map((workspace) => renderWorkspaceNode(workspace))}
                </div>
              )}
            </div>
            <form
              className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-surface p-3"
              onSubmit={(event) => void submitEditor(event)}
            >
              <h3 className="shrink-0 text-sm font-semibold text-text">{editorTitle}</h3>
              <FormField
                label={
                  editor.mode === "create-folder" || editor.mode === "edit-folder"
                    ? messages.workspace.folderName
                    : messages.workspace.name
                }
              >
                <input
                  className="field-control"
                  value={name}
                  autoFocus
                  required
                  disabled={busy}
                  onChange={(event) => {
                    setName(event.target.value);
                    if (error) setError("");
                  }}
                />
              </FormField>
              {editor.mode === "create-workspace" || editor.mode === "edit-workspace" ? (
                <FormField label={messages.workspace.workspaceDescription}>
                  <textarea
                    className="field-control min-h-12 resize-y"
                    value={description}
                    disabled={busy}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </FormField>
              ) : null}
              <FormField label={messages.workspace.createParent} hint={messages.workspace.createParentHint}>
                <div className="flex items-center justify-between gap-2 rounded-lg bg-subtle px-2.5 py-1.5 text-[11px] text-text-secondary">
                  <p className="min-w-0 truncate">
                    <span className="font-medium text-text">{messages.workspace.createLocation}: </span>
                    {folderPathLabel(folders, parentId, messages.workspace.topLevel)}
                  </p>
                  {parentId ? (
                    <button
                      type="button"
                      className="shrink-0 text-[11px] font-medium text-accent outline-none hover:underline"
                      disabled={busy}
                      onClick={() => selectParent(null)}
                    >
                      {messages.workspace.topLevel}
                    </button>
                  ) : null}
                </div>
              </FormField>
              {error || nameConflict ? (
                <p role="alert" className="rounded-lg border border-danger/30 bg-danger-subtle px-3 py-2 text-xs text-danger">
                  {error ||
                    (editor.mode === "create-folder" || editor.mode === "edit-folder"
                      ? messages.workspace.folderNameTaken
                      : messages.workspace.workspaceNameTaken)}
                </p>
              ) : null}
              <div className="mt-auto flex shrink-0 justify-end gap-2 pt-1">
                <Button type="button" variant="secondary" disabled={busy} onClick={cancelEditor}>
                  {messages.common.cancel}
                </Button>
                <Button type="submit" variant="primary" disabled={busy || !name.trim() || nameConflict}>
                  {busy ? messages.common.saving : messages.workspace.createSave}
                </Button>
              </div>
            </form>
          </SplitLayout>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-subtle/30 p-2">
            {rootFolders.length === 0 && rootWorkspaces.length === 0 ? (
              <p className="px-2 py-3 text-[12px] text-text-tertiary">{messages.workspace.noWorkspaces}</p>
            ) : (
              <div className="space-y-0.5">
                {rootFolders.map((folder) => renderFolderNode(folder))}
                {rootWorkspaces.map((workspace) => renderWorkspaceNode(workspace))}
              </div>
            )}
          </div>
        )}

        {!editor && error ? (
          <p role="alert" className="shrink-0 rounded-lg border border-danger/30 bg-danger-subtle px-3 py-2 text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </AppDialog>
  );
}
