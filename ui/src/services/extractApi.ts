import { httpRequest } from "@/services/httpClient";
import type { CreateExtractRequest, ExtractRecord } from "@/types/extract";

interface ExtractListResponse {
  extracts: ExtractRecord[];
}

export const extractApi = {
  getExtracts: (limit = 50) =>
    httpRequest<ExtractListResponse>(`/api/extracts?limit=${limit}`),
  getExtract: (extractId: string) =>
    httpRequest<ExtractRecord>(`/api/extracts/${extractId}`),
  createExtract: (request: CreateExtractRequest) =>
    httpRequest<ExtractRecord>("/api/extracts", {
      method: "POST",
      body: JSON.stringify(request),
    }),
  getDownloadUrl: (extractId: string) => `/api/extracts/${extractId}/file`,
};
