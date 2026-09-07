import { httpRequest } from "@/services/httpClient";
import type { ScheduleRequest, WorkspaceSchedule } from "@/types/schedule";
export const scheduleApi = {
  list: () => httpRequest<{ schedules: WorkspaceSchedule[] }>("/api/schedules"),
  create: (request: ScheduleRequest) => httpRequest<WorkspaceSchedule>("/api/schedules", { method: "POST", body: JSON.stringify(request) }),
  update: (id: string, request: ScheduleRequest) => httpRequest<WorkspaceSchedule>(`/api/schedules/${id}`, { method: "PATCH", body: JSON.stringify(request) }),
  remove: (id: string) => httpRequest<{ ok: true }>(`/api/schedules/${id}`, { method: "DELETE" }),
};
