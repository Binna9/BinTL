export interface EtlJob {
  id: string;
  status: string;
  source_path: string;
  output_path: string | null;
  spec_json: string;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface EtlJobLog {
  id: number;
  job_id: string;
  ts: string;
  level: string;
  message: string;
}

export type EtlJobRun = EtlJob & { logs: EtlJobLog[] };

export interface CreateEtlJobRequest {
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
}
