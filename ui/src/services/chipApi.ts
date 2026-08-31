import { httpRequest } from "@/services/httpClient";
import type {
  Chip,
  ChipListResponse,
  ChipRun,
  ChipRunListResponse,
  ChipRunLogsResponse,
  RegisterChipRequest,
  RunChipRequest,
  RunChipResponse,
  SaveChipRequest,
  UpdateChipRequest,
} from "@/types/chip";

export const chipApi = {
  listCatalog: () => httpRequest<ChipListResponse>("/api/chips"),
  register: (request: RegisterChipRequest) =>
    httpRequest<Chip>("/api/chips", {
      method: "POST",
      body: JSON.stringify(request),
    }),
  list: (workspaceId: string) =>
    httpRequest<ChipListResponse>(`/api/workspaces/${workspaceId}/chips`),
  create: (workspaceId: string, request: SaveChipRequest) =>
    httpRequest<Chip>(`/api/workspaces/${workspaceId}/chips`, {
      method: "POST",
      body: JSON.stringify(request),
    }),
  get: (id: string) => httpRequest<Chip>(`/api/chips/${id}`),
  update: (id: string, request: UpdateChipRequest) =>
    httpRequest<Chip>(`/api/chips/${id}`, {
      method: "PATCH",
      body: JSON.stringify(request),
    }),
  remove: (id: string) =>
    httpRequest<{ ok: true }>(`/api/chips/${id}`, { method: "DELETE" }),
  run: (id: string, request: RunChipRequest) =>
    httpRequest<RunChipResponse>(`/api/chips/${id}/run`, {
      method: "POST",
      body: JSON.stringify(request),
    }),
  listRuns: (workspaceId: string) =>
    httpRequest<ChipRunListResponse>(`/api/workspaces/${workspaceId}/runs`),
  getRun: (id: string) => httpRequest<ChipRun>(`/api/chip-runs/${id}`),
  getRunLogs: (id: string) =>
    httpRequest<ChipRunLogsResponse>(`/api/chip-runs/${id}/logs`),
};
