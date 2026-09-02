import { httpRequest, type HttpRequestInit } from "@/services/httpClient";
import type { CreateExtractRequest, ExtractRecord } from "@/types/extract";
import type { FilePreview } from "@/types/file";

interface ExtractListResponse {
  extracts: ExtractRecord[];
}

export const extractApi = {
  getExtracts: (limit = 50, init?: HttpRequestInit) =>
    httpRequest<ExtractListResponse>(`/api/extracts?limit=${limit}`, init),
  getExtract: (extractId: string) =>
    httpRequest<ExtractRecord>(`/api/extracts/${extractId}`),
  createExtract: (request: CreateExtractRequest) =>
    httpRequest<ExtractRecord>("/api/extracts", {
      method: "POST",
      body: JSON.stringify(request),
    }),
  deleteExtract: (extractId: string) =>
    httpRequest<{ ok: boolean }>(`/api/extracts/${extractId}`, {
      method: "DELETE",
    }),
  previewExtract: (extractId: string, limit = 200) =>
    httpRequest<FilePreview>(`/api/extracts/${extractId}/preview?limit=${limit}`),
  getDownloadUrl: (extractId: string) => `/api/extracts/${extractId}/file`,
  getLogs: (extractId: string) =>
    httpRequest<{ id: string; text: string }>(`/api/extracts/${extractId}/logs`),
};
