import { httpRequest } from "@/services/httpClient";
import type { SystemHealth } from "@/types/system";

export const systemApi = {
  getHealth: () => httpRequest<SystemHealth>("/api/health"),
};
