import { DragEvent, MouseEvent as ReactMouseEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  AppWindow,
  Check,
  ChevronDown,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { DialogContentTransition } from "@/components/DialogContentTransition";
import { SplitLayout } from "@/layouts/SplitLayout";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { isNotificationDialogOpen, showConfirm } from "@/lib/notifications";
import { workspaceApi } from "@/services/workspace/workspaceApi";
import type { Workspace, WorkspaceFolder } from "@/types/workspace";

type Editor =
  | { mode: "create-folder"; parentId: string | null }
  | { mode: "create-workspace"; parentId: string | null }
  | { mode: "edit-folder"; id: string }
  | { mode: "edit-workspace"; id: string };

type ItemKey = `folder:${string}` | `workspace:${string}`;
type DragPayload = ({ type: "folder"; id: string } | { type: "workspace"; id: string }) & {
  items?: ItemKey[];
};

const DRAG_MIME = "application/x-bintl-manage";
const DRAFT_PREFIX = "draft:";

function isDraftId(id: string) {
  return id.startsWith(DRAFT_PREFIX);
}

function draftId() {
  return `${DRAFT_PREFIX}${crypto.randomUUID()}`;
}

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

function foldersSnapshotEqual(a: WorkspaceFolder[], b: WorkspaceFolder[]) {
  if (a.length !== b.length) return false;
  const map = new Map(a.map((folder) => [folder.id, folder]));
  return b.every(
    (folder) => {
      const other = map.get(folder.id);
      return (
        other &&
        other.name === folder.name &&
        (other.parent_id ?? null) === (folder.parent_id ?? null)
      );
    },
  );
}

function workspacesSnapshotEqual(a: Workspace[], b: Workspace[]) {
  if (a.length !== b.length) return false;
  const map = new Map(a.map((workspace) => [workspace.id, workspace]));
  return b.every((workspace) => {
    const other = map.get(workspace.id);
    return (
      other &&
      other.name === workspace.name &&
      (other.description ?? "") === (workspace.description ?? "") &&
      (other.folder_id ?? null) === (workspace.folder_id ?? null)
    );
  });
}

function editorContentKey(editor: Editor | null): string {
  if (!editor) return "tree";
  if (editor.mode === "create-folder") return `create-folder:${editor.parentId ?? "root"}`;
  if (editor.mode === "create-workspace") return `create-workspace:${editor.parentId ?? "root"}`;
  if (editor.mode === "edit-folder") return `edit-folder:${editor.id}`;
  return `edit-workspace:${editor.id}`;
}

function folderDeleteOrder(folders: WorkspaceFolder[]) {
  const ids = new Set(folders.map((folder) => folder.id));
  const depth = (folder: WorkspaceFolder) => {
    let level = 0;
    let cursor = folder.parent_id;
    while (cursor && ids.has(cursor)) {
      level += 1;
      cursor = folders.find((item) => item.id === cursor)?.parent_id ?? null;
    }
    return level;
  };
  return [...folders].sort((a, b) => depth(b) - depth(a));
}

function folderCreateOrder(folders: WorkspaceFolder[]) {
  const ids = new Set(folders.map((folder) => folder.id));
  const depth = (folder: WorkspaceFolder) => {
    let level = 0;
    let cursor = folder.parent_id;
    while (cursor && ids.has(cursor)) {
      level += 1;
      cursor = folders.find((item) => item.id === cursor)?.parent_id ?? null;
    }
    return level;
  };
  return [...folders].sort((a, b) => depth(a) - depth(b));
}

function resolveFolderRef(
  id: string | null,
  idMap: Map<string, string>,
): string | null {
  if (!id) return null;
  const mapped = idMap.get(id);
  if (mapped) return mapped;
  if (isDraftId(id)) {
    throw new Error("draft folder was not created before use");
  }
  return id;
}

export function WorkspaceManageDialog({
  open,
  folders,
  workspaces,
  focusFolderId,
  onClose,
  onFoldersChange,
  onWorkspacesChange,
}: {
  open: boolean;
  folders: WorkspaceFolder[];
  workspaces: Workspace[];
  focusFolderId: string | null;
  onClose: () => void;
  onFoldersChange: (folders: WorkspaceFolder[]) => void;
  onWorkspacesChange: (workspaces: Workspace[]) => void;
}) {
  const { messages } = useLanguage();
  const originalFoldersRef = useRef<WorkspaceFolder[]>([]);
  const originalWorkspacesRef = useRef<Workspace[]>([]);
  const [draftFolders, setDraftFolders] = useState<WorkspaceFolder[]>([]);
  const [draftWorkspaces, setDraftWorkspaces] = useState<Workspace[]>([]);
  const [treeOpen, setTreeOpen] = useState<Record<string, boolean>>({});
  const [editor, setEditor] = useState<Editor | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [dropTarget, setDropTarget] = useState<string | "root" | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<ItemKey>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<ItemKey | null>(null);
  const confirmingSaveRef = useRef(false);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      setEditor(null);
      setError("");
      setBusy(false);
      setDragging(null);
      setDropTarget(null);
      setSelectedKeys(new Set());
      setSelectionAnchor(null);
      return;
    }
    // Seed drafts only when the dialog opens so prop refreshes don't wipe unsaved edits.
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    originalFoldersRef.current = folders;
    originalWorkspacesRef.current = workspaces;
    setDraftFolders(folders);
    setDraftWorkspaces(workspaces);
    setTreeOpen(ancestorOpenMap(folders, focusFolderId));
  }, [open, focusFolderId, folders, workspaces]);

  const isDirty = useMemo(
    () =>
      !foldersSnapshotEqual(originalFoldersRef.current, draftFolders) ||
      !workspacesSnapshotEqual(originalWorkspacesRef.current, draftWorkspaces),
    [draftFolders, draftWorkspaces],
  );

  const rootFolders = useMemo(
    () =>
      draftFolders
        .filter((folder) => !folder.parent_id)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [draftFolders],
  );
  const rootWorkspaces = useMemo(
    () =>
      draftWorkspaces
        .filter((workspace) => !workspace.folder_id)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [draftWorkspaces],
  );

  const visibleItemKeys = useMemo(() => {
    const result: ItemKey[] = [];
    const visit = (folder: WorkspaceFolder) => {
      result.push(`folder:${folder.id}`);
      if (!treeOpen[folder.id]) return;
      for (const child of draftFolders.filter((item) => item.parent_id === folder.id).sort((a, b) => a.name.localeCompare(b.name))) visit(child);
      for (const workspace of draftWorkspaces.filter((item) => item.folder_id === folder.id).sort((a, b) => a.name.localeCompare(b.name))) result.push(`workspace:${workspace.id}`);
    };
    for (const folder of rootFolders) visit(folder);
    for (const workspace of rootWorkspaces) result.push(`workspace:${workspace.id}`);
    return result;
  }, [draftFolders, draftWorkspaces, rootFolders, rootWorkspaces, treeOpen]);

  function selectItem(key: ItemKey, event: ReactMouseEvent) {
    if (event.shiftKey && selectionAnchor) {
      const from = visibleItemKeys.indexOf(selectionAnchor);
      const to = visibleItemKeys.indexOf(key);
      if (from >= 0 && to >= 0) {
        const range = visibleItemKeys.slice(Math.min(from, to), Math.max(from, to) + 1);
        setSelectedKeys(new Set((event.ctrlKey || event.metaKey) ? [...selectedKeys, ...range] : range));
        return;
      }
    }
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selectedKeys);
      if (next.has(key)) next.delete(key); else next.add(key);
      setSelectedKeys(next);
      setSelectionAnchor(key);
      return;
    }
    setSelectedKeys(new Set([key]));
    setSelectionAnchor(key);
  }

  function childFolders(parent: string) {
    return draftFolders
      .filter((folder) => folder.parent_id === parent)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function childWorkspaces(folderId: string | null) {
    return draftWorkspaces
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
      (next === editor.id || isFolderDescendant(draftFolders, next, editor.id))
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

  function toggleCreateFolder(under: string | null) {
    if (editor?.mode === "create-folder" && (editor.parentId ?? null) === under) {
      cancelEditor();
      return;
    }
    startCreateFolder(under);
  }

  function toggleCreateWorkspace(under: string | null) {
    if (editor?.mode === "create-workspace" && (editor.parentId ?? null) === under) {
      cancelEditor();
      return;
    }
    startCreateWorkspace(under);
  }

  function parseDragPayload(event: DragEvent): DragPayload | null {
    const raw = event.dataTransfer.getData(DRAG_MIME);
    if (!raw) return dragging;
    try {
      const parsed = JSON.parse(raw) as DragPayload;
      if (parsed?.type === "folder" || parsed?.type === "workspace") return parsed;
    } catch {
      return dragging;
    }
    return dragging;
  }

  function canDropOnFolder(folderId: string, payload: DragPayload | null) {
    if (!payload) return false;
    if (payload.items?.length) {
      return !payload.items.some((key) => {
        if (!key.startsWith("folder:")) return false;
        const id = key.slice("folder:".length);
        return id === folderId || isFolderDescendant(draftFolders, folderId, id);
      });
    }
    if (payload.type === "workspace") return true;
    if (payload.id === folderId) return false;
    return !isFolderDescendant(draftFolders, folderId, payload.id);
  }

  function canDropOnRoot(payload: DragPayload | null) {
    if (!payload) return false;
    if (payload.items?.length) {
      return payload.items.some((key) => {
        if (key.startsWith("workspace:")) {
          const workspace = draftWorkspaces.find((item) => item.id === key.slice("workspace:".length));
          return Boolean(workspace?.folder_id);
        }
        const folder = draftFolders.find((item) => item.id === key.slice("folder:".length));
        return Boolean(folder?.parent_id);
      });
    }
    if (payload.type === "workspace") return true;
    const folder = draftFolders.find((item) => item.id === payload.id);
    return Boolean(folder?.parent_id);
  }

  function moveFolder(folderId: string, newParentId: string | null) {
    const folder = draftFolders.find((item) => item.id === folderId);
    if (!folder || (folder.parent_id ?? null) === newParentId) return;
    if (
      newParentId &&
      (newParentId === folderId || isFolderDescendant(draftFolders, newParentId, folderId))
    ) {
      setError(messages.workspace.folderMoveIntoSelf);
      return;
    }
    if (folderNameTaken(draftFolders, folder.name, newParentId, folderId)) {
      setError(messages.workspace.folderNameTaken);
      return;
    }
    setDraftFolders(
      draftFolders.map((item) =>
        item.id === folderId ? { ...item, parent_id: newParentId } : item,
      ),
    );
    if (editor?.mode === "edit-folder" && editor.id === folderId) {
      setParentId(newParentId);
    }
    if (newParentId) {
      setTreeOpen((current) => ({ ...current, [newParentId]: true }));
    }
    if (error) setError("");
  }

  function moveWorkspace(workspaceId: string, newFolderId: string | null) {
    const workspace = draftWorkspaces.find((item) => item.id === workspaceId);
    if (!workspace || (workspace.folder_id ?? null) === newFolderId) return;
    setDraftWorkspaces(
      draftWorkspaces.map((item) =>
        item.id === workspaceId ? { ...item, folder_id: newFolderId } : item,
      ),
    );
    if (editor?.mode === "edit-workspace" && editor.id === workspaceId) {
      setParentId(newFolderId);
    }
    if (newFolderId) {
      setTreeOpen((current) => ({ ...current, [newFolderId]: true }));
    }
    if (error) setError("");
  }

  function handleDrop(targetFolderId: string | null, event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    const payload = parseDragPayload(event);
    setDropTarget(null);
    setDragging(null);
    if (!payload) return;
    if (payload.items?.length) {
      moveItemKeys(payload.items, targetFolderId);
      return;
    }
    if (payload.type === "folder") {
      moveFolder(payload.id, targetFolderId);
      return;
    }
    moveWorkspace(payload.id, targetFolderId);
  }

  function moveItemKeys(keys: ItemKey[], target: string | null) {
    const folderIds = keys.filter((key) => key.startsWith("folder:")).map((key) => key.slice("folder:".length));
    if (target && folderIds.some((id) => id === target || isFolderDescendant(draftFolders, target, id))) {
      setError(messages.workspace.folderMoveIntoSelf);
      return;
    }
    const keySet = new Set(keys);
    setDraftFolders((current) => current.map((folder) =>
      folderIds.includes(folder.id) ? { ...folder, parent_id: target } : folder,
    ));
    setDraftWorkspaces((current) => current.map((workspace) =>
      keySet.has(`workspace:${workspace.id}`) ? { ...workspace, folder_id: target } : workspace,
    ));
    if (target) setTreeOpen((current) => ({ ...current, [target]: true }));
    setError("");
  }

  function bindDropZone(target: string | "root", folderId: string | null) {
    return {
      onDragOver: (event: DragEvent) => {
        const payload = dragging ?? parseDragPayload(event);
        const allowed = folderId ? canDropOnFolder(folderId, payload) : canDropOnRoot(payload);
        if (!allowed) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        setDropTarget(target);
      },
      onDragLeave: (event: DragEvent) => {
        const next = event.relatedTarget as Node | null;
        if (next && event.currentTarget.contains(next)) return;
        setDropTarget((current) => (current === target ? null : current));
      },
      onDrop: (event: DragEvent) => {
        handleDrop(folderId, event);
      },
    };
  }

  function startEditFolder(folder: WorkspaceFolder) {
    setEditor({ mode: "edit-folder", id: folder.id });
    setName(folder.name);
    setDescription("");
    setParentId(folder.parent_id);
    setTreeOpen((current) => ({
      ...current,
      ...ancestorOpenMap(draftFolders, folder.parent_id),
    }));
    setError("");
  }

  function startEditWorkspace(workspace: Workspace) {
    setEditor({ mode: "edit-workspace", id: workspace.id });
    setName(workspace.name);
    setDescription(workspace.description ?? "");
    setParentId(workspace.folder_id ?? null);
    setTreeOpen((current) => ({
      ...current,
      ...ancestorOpenMap(draftFolders, workspace.folder_id ?? null),
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
      ? folderNameTaken(draftFolders, name, parentId, editingFolderId)
      : editor?.mode === "create-workspace" || editor?.mode === "edit-workspace"
        ? workspaceNameTaken(
            draftWorkspaces,
            name,
            editor.mode === "edit-workspace" ? editor.id : undefined,
          )
        : false;

  function commitEditor() {
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

    const now = new Date().toISOString();
    const ownerId =
      draftFolders[0]?.owner_user_id ?? draftWorkspaces[0]?.owner_user_id ?? "";

    if (editor.mode === "create-folder") {
      const created: WorkspaceFolder = {
        id: draftId(),
        owner_user_id: ownerId,
        parent_id: parentId,
        name: trimmed,
        created_at: now,
        updated_at: now,
      };
      setDraftFolders([...draftFolders, created]);
      setTreeOpen((current) => ({
        ...current,
        ...(parentId ? { [parentId]: true } : {}),
        [created.id]: true,
      }));
    } else if (editor.mode === "edit-folder") {
      if (
        parentId &&
        (parentId === editor.id || isFolderDescendant(draftFolders, parentId, editor.id))
      ) {
        setError(messages.workspace.folderMoveIntoSelf);
        return;
      }
      setDraftFolders(
        draftFolders.map((folder) =>
          folder.id === editor.id
            ? { ...folder, name: trimmed, parent_id: parentId, updated_at: now }
            : folder,
        ),
      );
    } else if (editor.mode === "create-workspace") {
      const created: Workspace = {
        id: draftId(),
        name: trimmed,
        description: description.trim() || null,
        layout: {},
        version: 0,
        created_at: now,
        updated_at: now,
        folder_id: parentId,
      };
      setDraftWorkspaces([...draftWorkspaces, created]);
      if (parentId) {
        setTreeOpen((current) => ({ ...current, [parentId]: true }));
      }
    } else {
      setDraftWorkspaces(
        draftWorkspaces.map((workspace) =>
          workspace.id === editor.id
            ? {
                ...workspace,
                name: trimmed,
                description: description.trim(),
                folder_id: parentId,
                updated_at: now,
              }
            : workspace,
        ),
      );
    }
    cancelEditor();
  }

  async function saveDraft() {
    if (!isDirty || busy || confirmingSaveRef.current) return;
    confirmingSaveRef.current = true;
    try {
      const confirmed = await showConfirm(
        messages.workspace.manageSaveConfirmTitle,
        messages.workspace.manageSaveConfirmMessage,
      );
      if (!confirmed) return;
      setBusy(true);
      setError("");
      const originalFolders = originalFoldersRef.current;
      const originalWorkspaces = originalWorkspacesRef.current;
      const folderIdMap = new Map<string, string>();
      let nextFolders = [...draftFolders];
      let nextWorkspaces = [...draftWorkspaces];

      // Create → reparent/update → then delete.
      // Deleting first cascades away children that were only moved in the draft, which
      // then fails later updates with SQLite FOREIGN KEY (787).
      const foldersToCreate = draftFolders.filter((folder) => isDraftId(folder.id));
      for (const folder of folderCreateOrder(foldersToCreate)) {
        const created = await workspaceApi.createFolder({
          name: folder.name,
          parent_id: resolveFolderRef(folder.parent_id, folderIdMap),
        });
        folderIdMap.set(folder.id, created.id);
        nextFolders = nextFolders.map((item) => (item.id === folder.id ? created : item));
      }

      for (const folder of nextFolders) {
        if (isDraftId(folder.id)) continue;
        const original = originalFolders.find((item) => item.id === folder.id);
        const parentIdResolved = resolveFolderRef(folder.parent_id, folderIdMap);
        if (
          !original ||
          (original.name === folder.name &&
            (original.parent_id ?? null) === (parentIdResolved ?? null))
        ) {
          continue;
        }
        const updated = await workspaceApi.updateFolder(folder.id, {
          name: folder.name,
          parent_id: parentIdResolved,
        });
        nextFolders = nextFolders.map((item) => (item.id === updated.id ? updated : item));
      }

      for (const workspace of nextWorkspaces) {
        if (isDraftId(workspace.id)) continue;
        const original = originalWorkspaces.find((item) => item.id === workspace.id);
        const folderRef = resolveFolderRef(workspace.folder_id ?? null, folderIdMap);
        if (
          !original ||
          (original.name === workspace.name &&
            (original.description ?? "") === (workspace.description ?? "") &&
            (original.folder_id ?? null) === (folderRef ?? null))
        ) {
          continue;
        }
        const updated = await workspaceApi.update(workspace.id, {
          name: workspace.name,
          description: workspace.description ?? "",
          folder_id: folderRef,
        });
        nextWorkspaces = nextWorkspaces.map((item) =>
          item.id === updated.id ? updated : item,
        );
      }

      for (const workspace of draftWorkspaces.filter((item) => isDraftId(item.id))) {
        const created = await workspaceApi.create({
          name: workspace.name,
          description: workspace.description?.trim() || undefined,
          folder_id: resolveFolderRef(workspace.folder_id ?? null, folderIdMap),
        });
        nextWorkspaces = nextWorkspaces.map((item) =>
          item.id === workspace.id ? created : item,
        );
      }

      const keptWorkspaceIds = new Set(
        draftWorkspaces.filter((workspace) => !isDraftId(workspace.id)).map((w) => w.id),
      );
      const workspacesToDelete = originalWorkspaces.filter(
        (workspace) => !keptWorkspaceIds.has(workspace.id),
      );
      for (const workspace of workspacesToDelete) {
        await workspaceApi.delete(workspace.id);
      }

      const keptFolderIds = new Set(
        draftFolders.filter((folder) => !isDraftId(folder.id)).map((folder) => folder.id),
      );
      const foldersToDelete = originalFolders.filter(
        (folder) => !keptFolderIds.has(folder.id),
      );
      for (const folder of folderDeleteOrder(foldersToDelete)) {
        await workspaceApi.deleteFolder(folder.id);
      }

      onFoldersChange(nextFolders);
      onWorkspacesChange(nextWorkspaces);
      onClose();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (message.includes("already exists")) {
        setError(messages.workspace.folderNameTaken);
      } else {
        setError(`${messages.workspace.manageSaveError}: ${message}`);
      }
    } finally {
      setBusy(false);
      confirmingSaveRef.current = false;
    }
  }

  const saveDraftRef = useRef(saveDraft);
  saveDraftRef.current = saveDraft;
  const removeSelectedRef = useRef(removeSelected);
  removeSelectedRef.current = removeSelected;

  const triggerSaveRef = useRef<() => void>(() => {});
  triggerSaveRef.current = () => {
    if (busy) return;
    if (editor) {
      const trimmed = name.trim();
      if (!trimmed) return;
      if (nameConflict) {
        setError(
          editor.mode === "create-folder" || editor.mode === "edit-folder"
            ? messages.workspace.folderNameTaken
            : messages.workspace.workspaceNameTaken,
        );
        return;
      }
      flushSync(() => commitEditor());
    }
    void saveDraftRef.current();
  };

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      // Confirm/alert dialogs sit above this popup — let them own Enter/Ctrl+S.
      if (isNotificationDialogOpen()) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        const target = event.target as HTMLElement | null;
        if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
        if (selectedKeys.size === 0) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) void removeSelectedRef.current();
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        triggerSaveRef.current();
        return;
      }
      if (event.key !== "Enter" || event.shiftKey) return;
      if (event.target instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      event.stopPropagation();
      triggerSaveRef.current();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, selectedKeys.size]);

  async function removeFolder(folder: WorkspaceFolder) {
    const confirmed = await showConfirm(
      messages.workspace.deleteFolderTitle,
      messages.workspace.deleteFolderMessage(folder.name),
      { tone: "danger", confirmLabel: messages.common.delete },
    );
    if (!confirmed) return;

    const dropIds = new Set<string>();
    const queue = [folder.id];
    while (queue.length > 0) {
      const id = queue.pop()!;
      dropIds.add(id);
      for (const child of draftFolders) {
        if (child.parent_id === id) queue.push(child.id);
      }
    }
    setDraftFolders(draftFolders.filter((item) => !dropIds.has(item.id)));
    setDraftWorkspaces(
      draftWorkspaces.map((workspace) =>
        workspace.folder_id && dropIds.has(workspace.folder_id)
          ? { ...workspace, folder_id: null }
          : workspace,
      ),
    );
    if (editor && "id" in editor && dropIds.has(editor.id)) cancelEditor();
    if (parentId && dropIds.has(parentId)) setParentId(null);
  }

  async function removeWorkspace(workspace: Workspace) {
    const confirmed = await showConfirm(
      messages.workspace.deleteWorkspaceTitle,
      messages.workspace.deleteWorkspaceMessage(workspace.name),
      { tone: "danger", confirmLabel: messages.common.delete },
    );
    if (!confirmed) return;

    const next = draftWorkspaces.filter((item) => item.id !== workspace.id);
    setDraftWorkspaces(next);
    if (editor?.mode === "edit-workspace" && editor.id === workspace.id) cancelEditor();
  }

  async function removeSelected() {
    if (selectedKeys.size === 0) return;
    const selectedWorkspaceIds = [...selectedKeys]
      .filter((key) => key.startsWith("workspace:"))
      .map((key) => key.slice("workspace:".length));
    const selectedFolderCount = [...selectedKeys].filter((key) => key.startsWith("folder:")).length;
    const hasContents = selectedWorkspaceIds.some((id) => {
      const workspace = draftWorkspaces.find((item) => item.id === id);
      return Boolean(
        workspace
        && (Object.keys(workspace.layout.nodes ?? {}).length > 0 || (workspace.edges?.length ?? 0) > 0),
      );
    });
    const confirmed = await showConfirm(
      messages.workspace.deleteSelectedTitle,
      messages.workspace.deleteSelectedMessage(selectedWorkspaceIds.length, selectedFolderCount, hasContents),
      { tone: "danger", confirmLabel: messages.common.delete },
    );
    if (!confirmed) return;
    const folderIds = new Set(
      [...selectedKeys].filter((key) => key.startsWith("folder:")).map((key) => key.slice("folder:".length)),
    );
    const queue = [...folderIds];
    while (queue.length > 0) {
      const id = queue.pop()!;
      for (const child of draftFolders) {
        if (child.parent_id === id && !folderIds.has(child.id)) {
          folderIds.add(child.id);
          queue.push(child.id);
        }
      }
    }
    setDraftFolders((current) => current.filter((folder) => !folderIds.has(folder.id)));
    setDraftWorkspaces((current) => current
      .filter((workspace) => !selectedKeys.has(`workspace:${workspace.id}`))
      .map((workspace) => workspace.folder_id && folderIds.has(workspace.folder_id)
        ? { ...workspace, folder_id: null }
        : workspace));
    setSelectedKeys(new Set());
    setSelectionAnchor(null);
    if (editor && "id" in editor && (folderIds.has(editor.id) || selectedKeys.has(`workspace:${editor.id}`))) cancelEditor();
  }

  async function requestClose() {
    if (busy) return;
    if (isDirty) {
      const confirmed = await showConfirm(
        messages.workspace.manageDiscardTitle,
        messages.workspace.manageDiscardMessage,
        { tone: "danger", confirmLabel: messages.common.close },
      );
      if (!confirmed) return;
    }
    onClose();
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
    const parentSelected = Boolean(editor) && parentId === folder.id;
    const multiSelected = selectedKeys.has(`folder:${folder.id}`);
    const banned =
      editor?.mode === "edit-folder" &&
      (folder.id === editor.id || isFolderDescendant(draftFolders, folder.id, editor.id));
    const isDragging = dragging?.type === "folder" && dragging.id === folder.id;
    const dropActive = dropTarget === folder.id;
    const isDraft = isDraftId(folder.id);

    return (
      <div key={folder.id} className="min-w-0">
        <div
          className={cn(
            "group flex w-full min-w-0 items-center gap-1 rounded-lg px-1 py-0.5 text-[12px] transition-colors",
            banned
              ? "opacity-40"
              : parentSelected || multiSelected
                ? "bg-accent-subtle font-semibold text-accent hover:bg-accent/15"
                : "text-text hover:bg-subtle",
            isDragging && "opacity-45",
            dropActive && "bg-accent/10 ring-1 ring-inset ring-accent/45",
            isDraft && "border border-dashed border-accent/35",
          )}
          {...bindDropZone(folder.id, folder.id)}
        >
          <button
            type="button"
            draggable={!busy && !banned}
            className="flex min-w-0 flex-1 cursor-grab items-center gap-2 rounded-lg px-1 py-1 text-left outline-none active:cursor-grabbing"
            aria-expanded={openNode}
            disabled={banned}
            onClick={(event) => {
              if (editor) {
                selectParent(parentSelected ? null : folder.id);
                return;
              }
              selectItem(`folder:${folder.id}`, event);
            }}
            onDragStart={(event) => {
              if (busy || banned) {
                event.preventDefault();
                return;
              }
            const key: ItemKey = `folder:${folder.id}`;
            const items = selectedKeys.has(key) ? [...selectedKeys] : [key];
            if (!selectedKeys.has(key)) {
              setSelectedKeys(new Set([key]));
              setSelectionAnchor(key);
            }
            const payload: DragPayload = { type: "folder", id: folder.id, items };
              event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
              event.dataTransfer.effectAllowed = "move";
              setDragging(payload);
            }}
            onDragEnd={() => {
              setDragging(null);
              setDropTarget(null);
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
              {iconButton(messages.workspace.newFolder, () => toggleCreateFolder(folder.id), (
                <FolderPlus className="size-3.5" aria-hidden="true" />
              ))}
              {iconButton(messages.workspace.newWorkspace, () => toggleCreateWorkspace(folder.id), (
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
    const isDragging = dragging?.type === "workspace" && dragging.id === workspace.id;
    const isDraft = isDraftId(workspace.id);
    const selected = selectedKeys.has(`workspace:${workspace.id}`);

    return (
      <div
        key={workspace.id}
        className={cn(
          "group flex w-full min-w-0 items-center gap-1 rounded-lg px-1 py-0.5 text-[12px] text-text-secondary transition-colors hover:bg-subtle hover:text-text",
          isDragging && "opacity-45",
          selected && "bg-accent-subtle font-semibold text-accent ring-1 ring-inset ring-accent/25",
          isDraft && "border border-dashed border-accent/35",
        )}
      >
        <button
          type="button"
          draggable={!busy}
          className="flex min-w-0 flex-1 cursor-grab items-center gap-2 rounded-lg px-1 py-1 text-left outline-none active:cursor-grabbing"
          onClick={(event) => selectItem(`workspace:${workspace.id}`, event)}
          onDragStart={(event) => {
            if (busy) {
              event.preventDefault();
              return;
            }
            const key: ItemKey = `workspace:${workspace.id}`;
            const items = selectedKeys.has(key) ? [...selectedKeys] : [key];
            if (!selectedKeys.has(key)) {
              setSelectedKeys(new Set([key]));
              setSelectionAnchor(key);
            }
            const payload: DragPayload = { type: "workspace", id: workspace.id, items };
            event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
            event.dataTransfer.effectAllowed = "move";
            setDragging(payload);
          }}
          onDragEnd={() => {
            setDragging(null);
            setDropTarget(null);
          }}
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

  const rootDropActive = dropTarget === "root";

  function renderTree(className?: string) {
    return (
      <div
        className={cn(
          "scroll-pane h-full min-h-0 overflow-y-auto rounded-xl border border-border bg-subtle/30 p-2",
          className,
          rootDropActive && "ring-1 ring-inset ring-accent/50 bg-accent/8",
        )}
        {...bindDropZone("root", null)}
      >
        {rootFolders.length === 0 && rootWorkspaces.length === 0 ? (
          <p className="px-2 py-3 text-[12px] text-text-tertiary">{messages.workspace.noWorkspaces}</p>
        ) : (
          <div className="space-y-0.5">
            {rootFolders.map((folder) => renderFolderNode(folder))}
            {rootWorkspaces.map((workspace) => renderWorkspaceNode(workspace))}
          </div>
        )}
      </div>
    );
  }

  function renderEditorForm() {
    if (!editor) return null;
    return (
      <section className="scroll-pane flex h-full min-h-0 flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-surface p-3">
        <div className="flex shrink-0 items-start justify-between gap-2">
          <h3 className="text-sm font-semibold text-text">{editorTitle}</h3>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              className="grid size-7 place-items-center rounded-lg text-text-tertiary outline-none transition-colors hover:bg-subtle hover:text-text"
              aria-label={messages.common.cancel}
              title={messages.common.cancel}
              disabled={busy}
              onClick={cancelEditor}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="grid size-7 place-items-center rounded-lg text-accent outline-none transition-colors hover:bg-accent-subtle disabled:opacity-40"
              aria-label={messages.workspace.applyDraft}
              title={messages.workspace.applyDraft}
              disabled={busy || !name.trim() || nameConflict}
              onClick={commitEditor}
            >
              <Check className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
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
              {folderPathLabel(draftFolders, parentId, messages.workspace.topLevel)}
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
      </section>
    );
  }

  return (
    <AppDialog
      open={open}
      title={messages.workspace.manageTitle}
      icon={<FolderOpen className="size-4 text-accent" aria-hidden="true" />}
      headerExtra={
        <span className="ml-auto truncate text-[11px] font-normal text-text-tertiary">
          {messages.workspace.multiSelectHint}
        </span>
      }
      className="h-[min(48rem,92vh)] w-[min(42rem,94vw)]"
      minWidth={420}
      minHeight={400}
      onClose={() => void requestClose()}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <p className="text-[11px] text-text-tertiary">
            {isDirty ? messages.workspace.manageUnsaved : messages.workspace.manageSavedHint}
          </p>
          <Button
            type="button"
            variant="primary"
            disabled={busy || !isDirty}
            onClick={() => triggerSaveRef.current()}
          >
            {busy ? messages.common.saving : messages.common.save}
          </Button>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
        <p className="shrink-0 text-xs text-text-secondary">
          {messages.workspace.manageHint} {messages.workspace.dragToMove}
        </p>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            type="button"
            variant={editor?.mode === "create-folder" && editor.parentId === null ? "primary" : "secondary"}
            disabled={busy}
            onClick={() => toggleCreateFolder(null)}
          >
            <FolderPlus className="size-3.5" aria-hidden="true" />
            {messages.workspace.newFolder}
          </Button>
          <Button
            type="button"
            variant={editor?.mode === "create-workspace" && editor.parentId === null ? "primary" : "secondary"}
            disabled={busy}
            onClick={() => toggleCreateWorkspace(null)}
          >
            <AppWindow className="size-3.5" aria-hidden="true" />
            {messages.workspace.newWorkspace}
          </Button>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <DialogContentTransition
            contentKey={editorContentKey(editor)}
            resetWhen={open}
            className="h-full min-h-0"
          >
            {editor ? (
              <div className="flex h-full min-h-0 flex-col">
                <SplitLayout
                  direction="vertical"
                  className="min-h-0 flex-1"
                  defaultSizes={[240]}
                  defaultRatio={0.55}
                  minSize={120}
                  insetGutter
                >
                  {renderTree()}
                  {renderEditorForm()}
                </SplitLayout>
              </div>
            ) : (
              renderTree("h-full")
            )}
          </DialogContentTransition>
        </div>

        {error && !editor ? (
          <p role="alert" className="shrink-0 rounded-lg border border-danger/30 bg-danger-subtle px-3 py-2 text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </AppDialog>
  );
}
