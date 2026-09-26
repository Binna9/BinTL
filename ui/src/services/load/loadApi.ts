import { httpRequest } from "@/services/httpClient";
import type { LoadDefinition, LoadRunSummary, LoadSpec } from "@/types/load";

export const loadApi = {
  list: () => httpRequest<{ loads: LoadDefinition[] }>("/api/loads"),
  create: (body: { name: string; spec: LoadSpec; input_chip_id?: string }) =>
    httpRequest<LoadDefinition>("/api/loads", { method: "POST", body: JSON.stringify(body) }),
  update: (id: string, body: { name: string; spec: LoadSpec; input_chip_id?: string }) =>
    httpRequest<LoadDefinition>(`/api/loads/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  run: (spec: LoadSpec, loadId?: string) =>
    httpRequest<LoadRunSummary & { ok: true; artifact_path?: string | null }>("/api/loads/run", {
      method: "POST",
      body: JSON.stringify({ spec, load_id: loadId }),
    }),
  lastRun: (id: string) => httpRequest<{ run: LoadRunSummary | null }>(`/api/loads/${id}/last-run`),
  remove: (id: string) => httpRequest<{ ok: true }>(`/api/loads/${id}`, { method: "DELETE" }),
};
