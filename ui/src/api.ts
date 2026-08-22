export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, { ...init, headers, credentials: "include" });
  if (res.status === 401 && !path.endsWith("/api/login")) {
    if (location.pathname !== "/login") {
      location.assign("/login");
    }
    throw new ApiError(401, "unauthorized");
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? res.statusText);
  }
  return data as T;
}

export type Health = { ok: boolean; version: string };
export type FileItem = { id: string; filename: string; size: number; stored_path: string };
export type Job = {
  id: string;
  status: string;
  source_path: string;
  output_path: string | null;
  spec_json: string;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};
export type JobLog = { id: number; job_id: string; ts: string; level: string; message: string };
export type JobDetail = Job & { logs: JobLog[] };

export const api = {
  health: () => request<Health>("/api/health"),
  login: (username: string, password: string) =>
    request<{ ok: boolean }>("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: boolean }>("/api/logout", { method: "POST" }),
  files: () => request<{ files: FileItem[] }>("/api/files"),
  upload: (file: File) => {
    const body = new FormData();
    body.append("file", file);
    return request<FileItem>("/api/files", { method: "POST", body });
  },
  jobs: (limit = 20) => request<{ jobs: Job[] }>(`/api/jobs?limit=${limit}`),
  job: (id: string) => request<JobDetail>(`/api/jobs/${id}`),
  createJob: (fileId: string) =>
    request<Job>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        file_id: fileId,
        spec: { version: 1, op: "identity", sink: "parquet" },
      }),
    }),
  runJob: (id: string) =>
    request<{ ok: boolean; id: string; status: string }>(`/api/jobs/${id}/run`, {
      method: "POST",
    }),
};

export function resultUrl(id: string): string {
  return `/api/jobs/${id}/result`;
}
