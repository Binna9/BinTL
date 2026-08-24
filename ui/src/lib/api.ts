import type {
  ColumnInfo,
  Connection,
  ConnectionDraft,
  CatalogItem,
  CatalogLayout,
  EtlJobDraft,
  ExtractDraft,
  ExtractItem,
  FileItem,
  Health,
  Job,
  JobRun,
  QueryOutcome,
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
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      throw new ApiError(res.status, text.trim() || res.statusText);
    }
  }
  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : res.statusText;
    throw new ApiError(res.status, message);
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
  connectionDatabases: (id: string) =>
    request<{ layout: CatalogLayout; current: string; databases: CatalogItem[] }>(
      `/api/connections/${id}/databases`,
    ),
  connectionSchemas: (id: string, database: string) =>
    request<{ database: string; schemas: CatalogItem[] }>(
      `/api/connections/${id}/schemas?database=${encodeURIComponent(database)}`,
    ),
  connectionRelations: (id: string, database: string, schema?: string) => {
    const query = new URLSearchParams({ database });
    if (schema) query.set("schema", schema);
    return request<{ database: string; schema?: string; tables: CatalogItem[] }>(
      `/api/connections/${id}/relations?${query}`,
    );
  },
  connectionColumns: (id: string, table: string, database?: string) => {
    const query = new URLSearchParams({ table });
    if (database) query.set("database", database);
    return request<{ table: string; columns: ColumnInfo[] }>(
      `/api/connections/${id}/columns?${query}`,
    );
  },
  connectionPreview: (id: string, table: string, limit = 50, database?: string) => {
    const query = new URLSearchParams({ table, limit: String(limit) });
    if (database) query.set("database", database);
    return request<TablePreview>(`/api/connections/${id}/preview?${query}`);
  },
  runQuery: (id: string, sql: string, limit = 100, database?: string) =>
    request<QueryOutcome>(`/api/connections/${id}/query`, {
      method: "POST",
      body: JSON.stringify({ sql, limit, database }),
    }),
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
