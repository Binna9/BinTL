import { httpRequest } from "@/services/httpClient";
import type { QueryResult } from "@/types/query";

export const queryApi = {
  runQuery: (
    connectionId: string,
    sql: string,
    limit = 100,
    database?: string,
    logId?: string,
  ) =>
    httpRequest<QueryResult>(`/api/connections/${connectionId}/query`, {
      method: "POST",
      body: JSON.stringify({ sql, limit, database, log_id: logId }),
    }),
  getLogs: (logId: string) =>
    httpRequest<{ area: string; id: string; text: string }>(`/api/logs/query/${logId}`, {
      silent: true,
    }),
};
