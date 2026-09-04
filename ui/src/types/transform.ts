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

export interface CombineSpec {
  mode: "join" | "union";
  right_dataset_id?: string;
  union_dataset_ids?: string[];
  on?: string[];
  how?: "left" | "inner";
}

export type TransformOperation =
  | { type: "clean"; steps: TransformStep[] }
  | {
      type: "join";
      right_dataset_id: string;
      on: string[];
      how?: "left" | "inner";
    }
  | { type: "union"; dataset_ids: string[] }
  | {
      type: "aggregate";
      group_by: string[];
      aggregations: Array<{
        column: string;
        function: "sum" | "count" | "mean" | "min" | "max";
        alias: string;
      }>;
    };

export interface TransformSpecV2 {
  version: 2 | 3;
  read?: { delimiter?: string; has_header?: boolean };
  steps?: TransformStep[];
  sink: "parquet";
  combine?: CombineSpec;
  operations?: TransformOperation[];
}

export interface SavedTransform {
  id: string;
  name: string;
  dataset_id: string;
  input_chip_id?: string | null;
  spec: {
    version?: number;
    steps?: TransformStep[];
    sink?: string;
    read?: { delimiter?: string; has_header?: boolean };
    combine?: CombineSpec;
    operations?: TransformOperation[];
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
