import { httpRequest, type HttpRequestInit } from "@/services/httpClient";
import type {
  Dataset,
  DatasetInspectResponse,
  DatasetListResponse,
  FramePreview,
} from "@/types/dataset";
import type { TransformSpecV2 } from "@/types/transform";

export const datasetApi = {
  list: (init?: HttpRequestInit) => httpRequest<DatasetListResponse>("/api/datasets", init),
  get: (id: string, init?: HttpRequestInit) =>
    httpRequest<Dataset>(`/api/datasets/${id}`, init),
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
  previewScript: (
    id: string,
    files: Record<string, string>,
    entry = "main.js",
    limit = 200,
    inputs?: { name: string; dataset_id: string }[],
  ) =>
    httpRequest<FramePreview>(`/api/datasets/${id}/script-preview`, {
      method: "POST",
      body: JSON.stringify({ files, entry, limit, inputs }),
    }),
  delete: (id: string) =>
    httpRequest<{ ok: boolean }>(`/api/datasets/${id}`, { method: "DELETE" }),
  getDownloadUrl: (id: string) => `/api/datasets/${id}/file`,
};
