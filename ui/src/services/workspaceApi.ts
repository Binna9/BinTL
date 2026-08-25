import { httpRequest } from "@/services/httpClient";
import type {
  CreateWorkspaceRequest,
  SaveWorkspaceRequest,
  SaveWorkspaceResponse,
  UpdateWorkspaceRequest,
  Workspace,
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
};
