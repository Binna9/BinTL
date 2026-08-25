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
  inspect: (id: string, limit = 50) =>
    httpRequest<DatasetInspectResponse>(`/api/datasets/${id}/inspect?limit=${limit}`, {
      method: "POST",
    }),
  preview: (id: string, spec: TransformSpecV2, limit = 50) =>
    httpRequest<FramePreview>(`/api/datasets/${id}/preview`, {
      method: "POST",
      body: JSON.stringify({ spec, limit }),
    }),
};
