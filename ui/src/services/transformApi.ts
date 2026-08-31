import { httpRequest } from "@/services/httpClient";
import type { TransformSpecV2 } from "@/types/transform";
import type {
  SavedTransform,
  TransformListResponse,
  TransformRunResponse,
} from "@/types/transform";

export const transformApi = {
  list: () => httpRequest<TransformListResponse>("/api/transforms"),
  get: (id: string) => httpRequest<SavedTransform>(`/api/transforms/${id}`),
  create: (body: { name: string; dataset_id: string; spec: TransformSpecV2 }) =>
    httpRequest<SavedTransform>("/api/transforms", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (
    id: string,
    body: { name?: string; dataset_id?: string; spec?: TransformSpecV2 },
  ) =>
    httpRequest<SavedTransform>(`/api/transforms/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  delete: (id: string) =>
    httpRequest<{ ok: boolean }>(`/api/transforms/${id}`, { method: "DELETE" }),
  run: (id: string) =>
    httpRequest<TransformRunResponse>(`/api/transforms/${id}/run`, {
      method: "POST",
    }),
};
