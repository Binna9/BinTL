export interface QueryResult {
  kind: "rows" | "exec";
  columns: string[];
  rows: string[][];
  row_count: number;
  truncated: boolean;
  elapsed_ms: number;
  limit: number;
}
