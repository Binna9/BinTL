export type Health = { ok: boolean; version: string };

export type FileItem = {
  id: string;
  filename: string;
  size: number;
  stored_path: string;
};

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

export type JobLog = {
  id: number;
  job_id: string;
  ts: string;
  level: string;
  message: string;
};

export type JobRun = Job & { logs: JobLog[] };

export type Connection = {
  id: string;
  name: string;
  driver: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  ssl: number;
  created_at: string;
};

export type ConnectionDraft = {
  name: string;
  driver: string;
  host: string;
  port?: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
};

export type ColumnInfo = {
  name: string;
  data_type: string;
  nullable: boolean;
};

export type TablePreview = {
  table: string;
  limit: number;
  columns: string[];
  rows: string[][];
};

export type ExtractItem = {
  id: string;
  connection_id: string;
  connection_name: string;
  table_name: string;
  delimiter: string;
  header: number;
  status: string;
  stored_path: string | null;
  filename: string | null;
  row_count: number | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type ExtractDraft = {
  connection_id: string;
  table: string;
  delimiter?: string;
  header?: boolean;
};

export type EtlJobDraft = {
  file_id?: string;
  extract_id?: string;
  connection_id?: string;
  table?: string;
  dest_connection_id?: string;
  dest_table?: string;
  mode?: string;
  select?: string[];
  filter?: string;
  rename?: Record<string, string>;
};
