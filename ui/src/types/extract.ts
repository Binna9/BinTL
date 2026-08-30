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

export interface CreateExtractRequest {
  connection_id: string;
  table?: string;
  sql?: string;
  delimiter?: string;
  header?: boolean;
  add_sequence?: boolean;
  database?: string;
}
