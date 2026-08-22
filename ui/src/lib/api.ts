import type {
  ColumnInfo,
  Connection,
  ConnectionDraft,
  EtlJobDraft,
  ExtractDraft,
  ExtractItem,
  FileItem,
  Health,
  Job,
  JobRun,
  TablePreview,
} from "@/types/pipeline";

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
  job: (id: string) => request<JobRun>(`/api/jobs/${id}`),
  connections: () => request<{ connections: Connection[] }>("/api/connections"),
  createConnection: (body: ConnectionDraft) =>
    request<Connection>("/api/connections", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteConnection: (id: string) =>
    request<{ ok: boolean }>(`/api/connections/${id}`, { method: "DELETE" }),
  testConnection: (id: string) =>
    request<{ ok: boolean; driver: string }>(`/api/connections/${id}/test`, {
      method: "POST",
    }),
  connectionTables: (id: string) =>
    request<{ tables: string[] }>(`/api/connections/${id}/tables`),
  connectionColumns: (id: string, table: string) =>
    request<{ table: string; columns: ColumnInfo[] }>(
      `/api/connections/${id}/columns?table=${encodeURIComponent(table)}`,
    ),
  connectionPreview: (id: string, table: string, limit = 50) =>
    request<TablePreview>(
      `/api/connections/${id}/preview?table=${encodeURIComponent(table)}&limit=${limit}`,
    ),
  extracts: (limit = 50) => request<{ extracts: ExtractItem[] }>(`/api/extracts?limit=${limit}`),
  extract: (id: string) => request<ExtractItem>(`/api/extracts/${id}`),
  createExtract: (body: ExtractDraft) =>
    request<ExtractItem>("/api/extracts", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  createEtlJob: (body: EtlJobDraft) =>
    request<Job>("/api/jobs", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  runJob: (id: string) =>
    request<{ ok: boolean; id: string; status: string }>(`/api/jobs/${id}/run`, {
      method: "POST",
    }),
};

export function resultUrl(id: string): string {
  return `/api/jobs/${id}/result`;
}

export function extractFileUrl(id: string): string {
  return `/api/extracts/${id}/file`;
}
