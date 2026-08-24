export interface DataConnection {
  id: string;
  name: string;
  driver: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  ssl: number;
  created_at: string;
}

export interface CreateConnectionRequest {
  name: string;
  driver: string;
  host: string;
  port?: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
}

export interface DatabaseColumn {
  name: string;
  data_type: string;
  nullable: boolean;
}

export interface TablePreview {
  table: string;
  limit: number;
  columns: string[];
  rows: string[][];
}

export interface CatalogEntry {
  name: string;
  kind: "database" | "schema" | "table" | "view";
  current?: boolean | null;
}

export type CatalogLayout = "database.schema.table" | "database.table";

export interface CatalogSelection {
  database: string;
  schema: string | null;
  table: string;
  qualified: string;
}
