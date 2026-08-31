export type SearchEntityType =
  | "workspace_folder"
  | "workspace"
  | "chip"
  | "dataset"
  | "connection"
  | "extract"
  | "transform";

export interface SearchHit {
  entity_type: SearchEntityType;
  entity_id: string;
  title: string;
  subtitle: string;
  preview: string;
  route: string;
  updated_at: string;
}

export interface SearchResponse {
  query: string;
  items: SearchHit[];
  total: number;
}

export interface RecentSearchesResponse {
  items: string[];
}
