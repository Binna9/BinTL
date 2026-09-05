import { httpRequest } from "@/services/httpClient";
import type { LoadDefinition, LoadSpec } from "@/types/load";

export const loadApi = {
  list: () => httpRequest<{ loads: LoadDefinition[] }>("/api/loads"),
  create: (body: { name: string; spec: LoadSpec; input_chip_id?: string }) =>
    httpRequest<LoadDefinition>("/api/loads", { method: "POST", body: JSON.stringify(body) }),
  update: (id: string, body: { name: string; spec: LoadSpec; input_chip_id?: string }) =>
    httpRequest<LoadDefinition>(`/api/loads/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  remove: (id: string) => httpRequest<{ ok: true }>(`/api/loads/${id}`, { method: "DELETE" }),
};
