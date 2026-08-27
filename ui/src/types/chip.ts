export type ChipKind = "extract" | "transform" | "load";
export type ChipEdgeKind = "data" | "then" | "on_error";
export type ChipConfig = Record<string, unknown>;

export interface Chip {
  id: string;
  workspace_id: string;
  name: string;
  kind: ChipKind;
  config: ChipConfig;
  revision: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ChipEdge {
  id: string;
  workspace_id: string;
  from_chip_id: string;
  to_chip_id: string;
  kind: ChipEdgeKind;
  from_port: string;
  to_port: string;
  created_at?: string;
}

export interface ChipRun {
  id: string;
  chip_id: string;
  workspace_id: string;
  kind: ChipKind;
  status: string;
  config_snapshot: ChipConfig;
  input_dataset_id?: string | null;
  output_dataset_id?: string | null;
  error_message?: string | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface ChipListResponse {
  chips: Chip[];
}

export interface ChipRunListResponse {
  runs: ChipRun[];
}

export interface ChipRunLogsResponse {
  id: string;
  text: string;
}

export interface SaveChipRequest {
  name: string;
  kind: ChipKind;
  config: ChipConfig;
}

export interface UpdateChipRequest {
  name?: string;
  kind?: ChipKind;
  config?: ChipConfig;
  active?: boolean;
}

export interface RunChipRequest {
  input_dataset_id?: string;
}

export interface RunChipResponse {
  ok: boolean;
  id: string;
  status: string;
  run: ChipRun;
}
