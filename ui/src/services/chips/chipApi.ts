import { httpRequest, type HttpRequestInit } from "@/services/httpClient";
import type {
  Chip,
  WorkspaceExecution,
  ChipInputSlotResponse,
  ChipListResponse,
  ChipRun,
  ChipRunListResponse,
  ChipRunLogsResponse,
  RegisterChipRequest,
  RunChipRequest,
  RunChipResponse,
  RunWorkspaceResponse,
  SaveChipRequest,
  UpdateChipRequest,
} from "@/types/chip";

export const chipApi = {
  listCatalog: async (init?: HttpRequestInit) => {
    const response = await httpRequest<ChipListResponse>("/api/chips", init);
    return { ...response, chips: response.chips.filter((chip) => chip.kind !== "memo") };
  },
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
  runWorkspace: (workspaceId: string) =>
    httpRequest<RunWorkspaceResponse>(`/api/workspaces/${workspaceId}/run`, {
      silent: true,
      method: "POST",
    }),
  cancelRun: (id: string) =>
    httpRequest<{ ok: true; status: "canceled"; id: string }>(`/api/chip-runs/${id}/cancel`, {
      method: "POST",
    }),
  cancelWorkspaceExecution: (workspaceId: string, executionId: string) =>
    httpRequest<{ ok: true; status: "canceled"; id: string }>(
      `/api/workspaces/${workspaceId}/executions/${executionId}/cancel`,
      { method: "POST" },
    ),
  listWorkspaceRuns: (workspaceId: string, init?: HttpRequestInit) =>
    httpRequest<{ runs: WorkspaceExecution[] }>(`/api/workspaces/${workspaceId}/executions`, init),
  listRuns: (workspaceId: string, init?: HttpRequestInit) =>
    httpRequest<ChipRunListResponse>(`/api/workspaces/${workspaceId}/runs`, init),
  getRun: (id: string) => httpRequest<ChipRun>(`/api/chip-runs/${id}`),
  getRunLogs: (id: string, init?: HttpRequestInit) =>
    httpRequest<ChipRunLogsResponse>(`/api/chip-runs/${id}/logs`, init),
  getInputSlot: (workspaceId: string, chipId: string, port?: "source" | "target") =>
    httpRequest<ChipInputSlotResponse>(
      `/api/workspaces/${workspaceId}/chips/${chipId}/input-slot${port ? `?port=${port}` : ""}`,
    ),
};
