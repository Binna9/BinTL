import { httpRequest } from "@/services/httpClient";
import type { RunJobResponse } from "@/types/api";
import type { EtlJobRun } from "@/types/job";

export const jobApi = {
  getJobRun: (jobId: string) =>
    httpRequest<EtlJobRun>(`/api/jobs/${jobId}`, { silent: true }),
  runJob: (jobId: string) =>
    httpRequest<RunJobResponse>(`/api/jobs/${jobId}/run`, {
      method: "POST",
    }),
  getResultUrl: (jobId: string) => `/api/jobs/${jobId}/result`,
};
