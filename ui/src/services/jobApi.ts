import { httpRequest } from "@/services/httpClient";
import type { RunJobResponse } from "@/types/api";
import type { CreateEtlJobRequest, EtlJob, EtlJobRun } from "@/types/job";

interface JobListResponse {
  jobs: EtlJob[];
}

export const jobApi = {
  getJobs: (limit = 20) =>
    httpRequest<JobListResponse>(`/api/jobs?limit=${limit}`),
  getJobRun: (jobId: string) =>
    httpRequest<EtlJobRun>(`/api/jobs/${jobId}`, { silent: true }),
  createJob: (request: CreateEtlJobRequest) =>
    httpRequest<EtlJob>("/api/jobs", {
      method: "POST",
      body: JSON.stringify(request),
    }),
  runJob: (jobId: string) =>
    httpRequest<RunJobResponse>(`/api/jobs/${jobId}/run`, {
      method: "POST",
    }),
  getResultUrl: (jobId: string) => `/api/jobs/${jobId}/result`,
};
