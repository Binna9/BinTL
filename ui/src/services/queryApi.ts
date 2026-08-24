import { httpRequest } from "@/services/httpClient";
import type { QueryResult } from "@/types/query";

export const queryApi = {
  runQuery: (
    connectionId: string,
    sql: string,
    limit = 100,
    database?: string,
  ) =>
    httpRequest<QueryResult>(`/api/connections/${connectionId}/query`, {
      method: "POST",
      body: JSON.stringify({ sql, limit, database }),
    }),
};
