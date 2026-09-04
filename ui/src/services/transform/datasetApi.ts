import { httpRequest } from "@/services/httpClient";
import type {
  Dataset,
  DatasetInspectResponse,
  DatasetListResponse,
  FramePreview,
} from "@/types/dataset";
import type { TransformSpecV2 } from "@/types/transform";

export const datasetApi = {
  list: () => httpRequest<DatasetListResponse>("/api/datasets"),
  get: (id: string) => httpRequest<Dataset>(`/api/datasets/${id}`),
  inspect: (id: string, limit = 200, silent = false) =>
    httpRequest<DatasetInspectResponse>(`/api/datasets/${id}/inspect?limit=${limit}`, {
      method: "POST",
      silent,
    }),
  preview: (id: string, spec: TransformSpecV2, limit = 200, silent = false) =>
    httpRequest<FramePreview>(`/api/datasets/${id}/preview`, {
      method: "POST",
      body: JSON.stringify({ spec, limit }),
      silent,
    }),
  delete: (id: string) =>
    httpRequest<{ ok: boolean }>(`/api/datasets/${id}`, { method: "DELETE" }),
  getDownloadUrl: (id: string) => `/api/datasets/${id}/file`,
};
