export type LoadDestination =
  | { type: "database"; connection_id: string; database?: string; table: string }
  | { type: "file"; format: "csv" | "parquet"; filename: string };

export interface LoadSpec {
  input_dataset_id?: string;
  destination: LoadDestination;
  write_mode: "append" | "truncate" | "upsert" | "recreate" | "replace";
  conflict_keys?: string[];
}

export interface LoadDefinition {
  id: string;
  owner_user_id: string;
  name: string;
  destination_type: "database" | "file";
  spec: LoadSpec;
  created_at: string;
  updated_at: string;
}
