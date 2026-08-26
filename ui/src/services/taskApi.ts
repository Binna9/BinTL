import { httpRequest } from "@/services/httpClient";
import type {
  RunTaskRequest,
  RunTaskResponse,
  SaveTaskRequest,
  TaskDefinition,
  TaskListResponse,
  TaskRun,
  TaskRunListResponse,
  TaskRunLogsResponse,
  UpdateTaskRequest,
} from "@/types/task";

export const taskApi = {
  list: (workspaceId: string) =>
    httpRequest<TaskListResponse>(`/api/workspaces/${workspaceId}/tasks`),
  create: (workspaceId: string, request: SaveTaskRequest) =>
    httpRequest<TaskDefinition>(`/api/workspaces/${workspaceId}/tasks`, {
      method: "POST",
      body: JSON.stringify(request),
    }),
  get: (id: string) => httpRequest<TaskDefinition>(`/api/tasks/${id}`),
  update: (id: string, request: UpdateTaskRequest) =>
    httpRequest<TaskDefinition>(`/api/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(request),
    }),
  remove: (id: string) =>
    httpRequest<{ ok: true }>(`/api/tasks/${id}`, { method: "DELETE" }),
  run: (id: string, request: RunTaskRequest = {}) =>
    httpRequest<RunTaskResponse>(`/api/tasks/${id}/run`, {
      method: "POST",
      body: JSON.stringify(request),
    }),
  listRuns: (workspaceId: string) =>
    httpRequest<TaskRunListResponse>(`/api/workspaces/${workspaceId}/runs`),
  getRun: (id: string) => httpRequest<TaskRun>(`/api/task-runs/${id}`),
  getRunLogs: (id: string) =>
    httpRequest<TaskRunLogsResponse>(`/api/task-runs/${id}/logs`),
};
