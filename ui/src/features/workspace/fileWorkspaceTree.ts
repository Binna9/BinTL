import type { Workspace, WorkspaceFolder } from "@/types/workspace";

export type FileTreeSelection =
  | { type: "all" }
  | { type: "folder"; id: string }
  | { type: "workspace"; id: string };

export interface CatalogFile {
  id: string;
  name: string;
  workspace_id: string;
}

const LAST_FILE_WORKSPACE_KEY = "bintl.last-file-workspace";

export function readLastFileWorkspace(): string {
  try {
    return localStorage.getItem(LAST_FILE_WORKSPACE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeLastFileWorkspace(id: string) {
  try {
    localStorage.setItem(LAST_FILE_WORKSPACE_KEY, id);
  } catch {
    // ponytail: private-mode storage can throw; picker still works without memory
  }
}

export function descendantFolderIds(folders: WorkspaceFolder[], folderId: string): Set<string> {
  const ids = new Set<string>([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders) {
      if (folder.parent_id && ids.has(folder.parent_id) && !ids.has(folder.id)) {
        ids.add(folder.id);
        grew = true;
      }
    }
  }
  return ids;
}

export function workspaceIdsUnderFolder(
  folders: WorkspaceFolder[],
  workspaces: Workspace[],
  folderId: string,
): Set<string> {
  const folderIds = descendantFolderIds(folders, folderId);
  return new Set(
    workspaces
      .filter((workspace) => workspace.folder_id != null && folderIds.has(workspace.folder_id))
      .map((workspace) => workspace.id),
  );
}

export function filterItemsByFileTree<T extends { workspace_id: string }>(
  items: T[],
  selection: FileTreeSelection,
  folders: WorkspaceFolder[],
  workspaces: Workspace[],
): T[] {
  if (selection.type === "all") return items;
  if (selection.type === "workspace") {
    return items.filter((item) => item.workspace_id === selection.id);
  }
  const ids = workspaceIdsUnderFolder(folders, workspaces, selection.id);
  return items.filter((item) => ids.has(item.workspace_id));
}

export function filesForWorkspace(files: CatalogFile[], workspaceId: string): CatalogFile[] {
  return files.filter((file) => file.workspace_id === workspaceId);
}

export function fileCountForFolder(
  files: CatalogFile[],
  folders: WorkspaceFolder[],
  workspaces: Workspace[],
  folderId: string,
): number {
  const ids = workspaceIdsUnderFolder(folders, workspaces, folderId);
  return files.filter((file) => ids.has(file.workspace_id)).length;
}

function nameMatches(name: string, query: string) {
  return name.toLocaleLowerCase().includes(query);
}

export function filterCatalogTree(
  folders: WorkspaceFolder[],
  workspaces: Workspace[],
  query: string,
): { folders: WorkspaceFolder[]; workspaces: Workspace[]; openIds: Record<string, boolean> } {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return { folders, workspaces, openIds: {} };

  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const subtreeFolderIds = new Set<string>();
  for (const folder of folders) {
    if (!nameMatches(folder.name, q)) continue;
    for (const id of descendantFolderIds(folders, folder.id)) subtreeFolderIds.add(id);
  }

  const ancestorIds = new Set<string>();
  function addAncestors(folderId: string | null | undefined) {
    let cursor = folderId ?? null;
    while (cursor) {
      ancestorIds.add(cursor);
      cursor = folderById.get(cursor)?.parent_id ?? null;
    }
  }
  for (const id of subtreeFolderIds) addAncestors(folderById.get(id)?.parent_id);
  const matchingWorkspaceIds = new Set(
    workspaces.filter((workspace) => nameMatches(workspace.name, q)).map((workspace) => workspace.id),
  );
  for (const workspace of workspaces) {
    if (matchingWorkspaceIds.has(workspace.id)) addAncestors(workspace.folder_id);
  }

  const visibleFolderIds = new Set([...subtreeFolderIds, ...ancestorIds]);
  const visibleWorkspaces = workspaces.filter(
    (workspace) =>
      matchingWorkspaceIds.has(workspace.id) ||
      (workspace.folder_id != null && subtreeFolderIds.has(workspace.folder_id)),
  );
  const openIds: Record<string, boolean> = {};
  for (const id of visibleFolderIds) openIds[id] = true;
  for (const workspace of visibleWorkspaces) openIds[`ws:${workspace.id}`] = true;
  return {
    folders: folders.filter((folder) => visibleFolderIds.has(folder.id)),
    workspaces: visibleWorkspaces,
    openIds,
  };
}

if (import.meta.env.DEV) {
  const folders = [
    { id: "a", owner_user_id: "u", parent_id: null, name: "A", created_at: "", updated_at: "" },
    { id: "b", owner_user_id: "u", parent_id: "a", name: "B", created_at: "", updated_at: "" },
  ];
  const workspaces = [
    { id: "w1", name: "W1", layout: {}, version: 1, created_at: "", updated_at: "", folder_id: "b" },
    { id: "w2", name: "W2", layout: {}, version: 1, created_at: "", updated_at: "", folder_id: "a" },
    { id: "w3", name: "W3", layout: {}, version: 1, created_at: "", updated_at: "", folder_id: null },
  ];
  const items = [
    { id: "f1", workspace_id: "w1" },
    { id: "f2", workspace_id: "w2" },
    { id: "f3", workspace_id: "w3" },
  ];
  console.assert(
    filterItemsByFileTree(items, { type: "all" }, folders, workspaces).length === 3,
    "file tree: all",
  );
  console.assert(
    filterItemsByFileTree(items, { type: "workspace", id: "w1" }, folders, workspaces)
      .map((item) => item.id)
      .join(",") === "f1",
    "file tree: workspace",
  );
  console.assert(
    filterItemsByFileTree(items, { type: "folder", id: "a" }, folders, workspaces)
      .map((item) => item.id)
      .join(",") === "f1,f2",
    "file tree: nested folder",
  );
  console.assert(fileCountForFolder(items.map((item) => ({ ...item, name: item.id })), folders, workspaces, "b") === 1, "file tree: child folder count");
  const byWorkspace = filterCatalogTree(folders, workspaces, "w1");
  console.assert(byWorkspace.workspaces.map((row) => row.id).join(",") === "w1" && byWorkspace.folders.map((row) => row.id).join(",") === "a,b", "catalog tree: workspace match keeps ancestors");
  const byFolder = filterCatalogTree(folders, workspaces, "A");
  console.assert(byFolder.folders.map((row) => row.id).join(",") === "a,b" && byFolder.workspaces.map((row) => row.id).join(",") === "w1,w2", "catalog tree: folder match keeps subtree");
  console.assert(filterCatalogTree(folders, workspaces, "nope").workspaces.length === 0, "catalog tree: empty");
}
