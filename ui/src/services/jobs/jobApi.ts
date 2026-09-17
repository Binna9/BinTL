import { httpRequest, type HttpRequestInit } from "@/services/httpClient";
import type { RunJobResponse } from "@/types/api";
import type { EtlJob, EtlJobRun } from "@/types/job";

export const jobApi = {
  list: (limit = 200, init?: HttpRequestInit) =>
    httpRequest<{ jobs: EtlJob[] }>(`/api/jobs?limit=${limit}`, init),
  getJobRun: (jobId: string) =>
    httpRequest<EtlJobRun>(`/api/jobs/${jobId}`, { silent: true }),
  runJob: (jobId: string) =>
    httpRequest<RunJobResponse>(`/api/jobs/${jobId}/run`, {
      method: "POST",
    }),
  getResultUrl: (jobId: string) => `/api/jobs/${jobId}/result`,
};
