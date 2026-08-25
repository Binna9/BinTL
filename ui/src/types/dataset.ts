export interface DatasetColumn {
  name: string;
  dtype: string;
}

export interface DatasetOrigin {
  extract_id: string | null;
  table_name: string;
  connection_name: string;
}

export interface Dataset {
  id: string;
  kind: "upload" | "database" | "api" | string;
  filename: string;
  stored_path: string;
  size_bytes: number | null;
  delimiter: string | null;
  has_header: boolean | null;
  columns: DatasetColumn[];
  row_count: number | null;
  inspected_at: string | null;
  created_at: string;
  updated_at: string;
  workspace_id: string;
  producer_task_run_id: string | null;
  available: boolean;
  origin: DatasetOrigin | null;
}

export interface DatasetListResponse {
  datasets: Dataset[];
}

export interface FramePreview {
  columns: DatasetColumn[];
  rows: string[][];
  sampled_rows: number;
  row_count: number | null;
  truncated: boolean;
}

export interface DatasetInspectResponse {
  dataset: Dataset;
  preview: FramePreview;
}
