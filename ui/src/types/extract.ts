export type ExtractKind = "database" | "api";

export interface ExtractRecord {
  id: string;
  kind: ExtractKind;
  connection_id: string;
  connection_name: string;
  table_name: string;
  delimiter: string;
  header: number;
  add_sequence?: number;
  status: string;
  stored_path: string | null;
  filename: string | null;
  row_count: number | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  sql_text?: string | null;
}

export interface HttpKv {
  name: string;
  value: string;
}

export interface HttpSource {
  type: "http";
  method: string;
  path: string;
  query: HttpKv[];
  headers: HttpKv[];
  body?: string | null;
  records_path: string;
}

export interface CreateExtractRequest {
  kind?: ExtractKind;
  connection_id: string;
  table?: string;
  sql?: string;
  source?: HttpSource | Record<string, unknown>;
  delimiter?: string;
  header?: boolean;
  add_sequence?: boolean;
  database?: string;
  filename?: string;
}

export interface HttpPreviewRequest {
  connection_id: string;
  method: string;
  path: string;
  query?: HttpKv[];
  headers?: HttpKv[];
  body?: string | null;
  records_path?: string;
  limit?: number;
}

export interface HttpPreviewResponse {
  status: number;
  columns: string[];
  rows: string[][];
  row_count: number;
  truncated: boolean;
  limit: number;
}
