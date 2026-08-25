export type TransformStep =
  | { op: "select"; columns: string[] }
  | { op: "drop"; columns: string[] }
  | { op: "rename"; map: Record<string, string> }
  | { op: "filter"; expr: string }
  | { op: "cast"; columns: Record<string, string> }
  | { op: "fill_null"; value: string; columns: string[] }
  | { op: "sort"; by: { column: string; descending: boolean }[] }
  | { op: "unique"; subset?: string[]; keep?: "first" | "last" | "none" | "any" };

export type StepOp = TransformStep["op"];

export interface TransformSpecV2 {
  version: 2;
  read?: { delimiter?: string; has_header?: boolean };
  steps: TransformStep[];
  sink: "parquet";
}

export interface SavedTransform {
  id: string;
  name: string;
  dataset_id: string;
  spec: {
    version?: number;
    steps?: TransformStep[];
    sink?: string;
    read?: { delimiter?: string; has_header?: boolean };
  };
  created_at: string;
  updated_at: string;
}

export interface TransformListResponse {
  transforms: SavedTransform[];
}

export interface TransformRunResponse {
  ok: boolean;
  id: string;
  status: string;
}
