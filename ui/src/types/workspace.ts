import type { Chip, ChipEdge } from "@/types/chip";

export interface WorkspaceFolder {
  id: string;
  owner_user_id: string;
  parent_id: string | null;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface Workspace {
  id: string;
  name: string;
  description?: string | null;
  layout: WorkspaceLayout;
  version: number;
  created_at: string;
  updated_at: string;
  owner_user_id?: string | null;
  folder_id?: string | null;
  edges?: ChipEdge[];
}

export interface WorkspaceLayout {
  nodes?: Record<string, { x: number; y: number }>;
  view?: { x: number; y: number };
}

export interface WorkspaceListResponse {
  workspaces: Workspace[];
}

export interface WorkspaceFolderListResponse {
  folders: WorkspaceFolder[];
}

export interface CreateWorkspaceRequest {
  name: string;
  description?: string;
  folder_id?: string | null;
}

export interface CreateFolderRequest {
  name: string;
  parent_id?: string | null;
}

export interface UpdateFolderRequest {
  name?: string;
  parent_id?: string | null;
}

export interface UpdateWorkspaceRequest {
  name?: string;
  description?: string;
  layout?: WorkspaceLayout;
  folder_id?: string | null;
}

export interface SaveWorkspaceEdge {
  id: string;
  from_chip_id: string;
  to_chip_id: string;
  kind: ChipEdge["kind"];
  from_port?: string;
  to_port?: string;
}

export interface SaveWorkspaceRequest {
  layout: WorkspaceLayout;
  chips: string[];
  edges: SaveWorkspaceEdge[];
}

export interface SaveWorkspaceResponse {
  workspace: Workspace;
  chips: Chip[];
  edges: ChipEdge[];
}
