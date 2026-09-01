import { httpRequest, type HttpRequestInit } from "@/services/httpClient";
import type {
  Chip,
  ChipInputSlotResponse,
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
  listCatalog: (init?: HttpRequestInit) => httpRequest<ChipListResponse>("/api/chips", init),
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
  listRuns: (workspaceId: string, init?: HttpRequestInit) =>
    httpRequest<ChipRunListResponse>(`/api/workspaces/${workspaceId}/runs`, init),
  getRun: (id: string) => httpRequest<ChipRun>(`/api/chip-runs/${id}`),
  getRunLogs: (id: string) =>
    httpRequest<ChipRunLogsResponse>(`/api/chip-runs/${id}/logs`),
  getInputSlot: (workspaceId: string, chipId: string) =>
    httpRequest<ChipInputSlotResponse>(
      `/api/workspaces/${workspaceId}/chips/${chipId}/input-slot`,
    ),
};
