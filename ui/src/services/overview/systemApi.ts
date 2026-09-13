import { httpRequest, type HttpRequestInit } from "@/services/httpClient";
import type { SystemHealth } from "@/types/system";

export const systemApi = {
  getHealth: (init?: HttpRequestInit) => httpRequest<SystemHealth>("/api/health", init),
};
