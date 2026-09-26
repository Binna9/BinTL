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
  kind?: string;
  filename?: string | null;
  row_count?: number | null;
  workspace_id?: string;
}

export interface EtlJobLog {
  id: number;
  job_id: string;
  ts: string;
  level: string;
  message: string;
}

export type EtlJobRun = EtlJob & { logs: EtlJobLog[] };
