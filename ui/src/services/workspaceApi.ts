import { httpRequest } from "@/services/httpClient";
import type {
  CreateFolderRequest,
  CreateWorkspaceRequest,
  SaveWorkspaceRequest,
  SaveWorkspaceResponse,
  UpdateFolderRequest,
  UpdateWorkspaceRequest,
  Workspace,
  WorkspaceFolder,
  WorkspaceFolderListResponse,
  WorkspaceListResponse,
} from "@/types/workspace";

export const workspaceApi = {
  list: () => httpRequest<WorkspaceListResponse>("/api/workspaces"),
  create: (request: CreateWorkspaceRequest) =>
    httpRequest<Workspace>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify(request),
    }),
  get: (id: string) => httpRequest<Workspace>(`/api/workspaces/${id}`),
  update: (id: string, request: UpdateWorkspaceRequest) =>
    httpRequest<Workspace>(`/api/workspaces/${id}`, {
      method: "PATCH",
      body: JSON.stringify(request),
    }),
  save: (id: string, request: SaveWorkspaceRequest) =>
    httpRequest<SaveWorkspaceResponse>(`/api/workspaces/${id}/save`, {
      method: "PUT",
      body: JSON.stringify(request),
    }),
  listFolders: () => httpRequest<WorkspaceFolderListResponse>("/api/workspace-folders"),
  createFolder: (request: CreateFolderRequest) =>
    httpRequest<WorkspaceFolder>("/api/workspace-folders", {
      method: "POST",
      body: JSON.stringify(request),
    }),
  updateFolder: (id: string, request: UpdateFolderRequest) =>
    httpRequest<WorkspaceFolder>(`/api/workspace-folders/${id}`, {
      method: "PATCH",
      body: JSON.stringify(request),
    }),
  deleteFolder: (id: string) =>
    httpRequest<{ ok: boolean }>(`/api/workspace-folders/${id}`, {
      method: "DELETE",
    }),
};
