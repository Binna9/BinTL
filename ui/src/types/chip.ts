export type ChipKind = "extract" | "transform" | "load";
export type ChipEdgeKind = "data" | "on_success" | "on_error" | "always";
export type ChipConfig = Record<string, unknown>;

/** Client-only workspace draft; never sent to the server until canvas save. */
export const DRAFT_CHIP_ID_PREFIX = "draft:";

export function isDraftChipId(id: string): boolean {
  return id.startsWith(DRAFT_CHIP_ID_PREFIX);
}

export interface ChipBinding {
  ref_kind: "extract_definition" | "transform" | "load_definition";
  ref_id: string;
}

export interface ChipOutput {
  filename: string;
  available: boolean;
  dataset_id?: string | null;
}

export interface Chip {
  id: string;
  owner_user_id: string;
  name: string;
  kind: ChipKind;
  config: ChipConfig;
  binding?: ChipBinding | null;
  output?: ChipOutput | null;
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

export interface RegisterChipRequest {
  name: string;
  kind: ChipKind;
  workspace_id?: string;
  place_on_workspace?: boolean;
  run_after?: boolean;
  extract?: ChipConfig;
  transform_id?: string;
  load_definition_id?: string;
}

export interface RunChipRequest {
  workspace_id: string;
  input_dataset_id?: string;
}

export interface RunChipResponse {
  ok: boolean;
  id: string;
  status: string;
  run: ChipRun;
}

export interface ChipInputSlotResponse {
  mode: "unwired" | "planned" | "materialized";
  dataset_id?: string;
  source_chip_id?: string;
  source_chip_name?: string;
  source_chip_kind?: ChipKind;
  status?: string;
  columns?: { name: string; dtype?: string; type?: string }[];
  dataset?: Record<string, unknown>;
  planned?: {
    dataset_id: string;
    status: string;
    source_chip_id: string;
    consumer_chip_id: string;
    columns: { name: string; dtype?: string; type?: string }[];
  };
}
