import { httpRequest } from "@/services/httpClient";
import type { ApiSuccess, TestConnectionResponse } from "@/types/api";
import type {
  CatalogEntry,
  CatalogLayout,
  CreateConnectionRequest,
  DataConnection,
  DatabaseColumn,
  TablePreview,
} from "@/types/connection";

interface ConnectionListResponse {
  connections: DataConnection[];
}

interface TableListResponse {
  tables: string[];
}

interface DatabaseListResponse {
  layout: CatalogLayout;
  current: string;
  databases: CatalogEntry[];
}

interface SchemaListResponse {
  database: string;
  schemas: CatalogEntry[];
}

interface RelationListResponse {
  database: string;
  schema?: string;
  tables: CatalogEntry[];
}

interface ColumnListResponse {
  table: string;
  columns: DatabaseColumn[];
}

export const connectionApi = {
  getConnections: () => httpRequest<ConnectionListResponse>("/api/connections"),
  createConnection: (request: CreateConnectionRequest) =>
    httpRequest<DataConnection>("/api/connections", {
      method: "POST",
      body: JSON.stringify(request),
    }),
  deleteConnection: (connectionId: string) =>
    httpRequest<ApiSuccess>(`/api/connections/${connectionId}`, { method: "DELETE" }),
  testConnection: (connectionId: string) =>
    httpRequest<TestConnectionResponse>(`/api/connections/${connectionId}/test`, {
      method: "POST",
    }),
  getTables: (connectionId: string) =>
    httpRequest<TableListResponse>(`/api/connections/${connectionId}/tables`),
  getDatabases: (connectionId: string) =>
    httpRequest<DatabaseListResponse>(`/api/connections/${connectionId}/databases`),
  getSchemas: (connectionId: string, database: string) =>
    httpRequest<SchemaListResponse>(
      `/api/connections/${connectionId}/schemas?database=${encodeURIComponent(database)}`,
    ),
  getRelations: (connectionId: string, database: string, schema?: string) => {
    const query = new URLSearchParams({ database });
    if (schema) query.set("schema", schema);
    return httpRequest<RelationListResponse>(
      `/api/connections/${connectionId}/relations?${query}`,
    );
  },
  getColumns: (
    connectionId: string,
    table: string,
    database?: string,
  ) => {
    const query = new URLSearchParams({ table });
    if (database) query.set("database", database);
    return httpRequest<ColumnListResponse>(
      `/api/connections/${connectionId}/columns?${query}`,
    );
  },
  getPreview: (
    connectionId: string,
    table: string,
    limit = 50,
    database?: string,
  ) => {
    const query = new URLSearchParams({ table, limit: String(limit) });
    if (database) query.set("database", database);
    return httpRequest<TablePreview>(
      `/api/connections/${connectionId}/preview?${query}`,
    );
  },
};
