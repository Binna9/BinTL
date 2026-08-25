import type { TaskConfig, TaskDefinition, TaskKind } from "@/types/task";

export interface Workspace {
  id: string;
  name: string;
  description?: string | null;
  layout: WorkspaceLayout;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceLayout {
  nodes?: Record<string, { x: number; y: number }>;
}

export interface WorkspaceListResponse {
  workspaces: Workspace[];
}

export interface CreateWorkspaceRequest {
  name: string;
  description?: string;
}

export interface UpdateWorkspaceRequest {
  name?: string;
  description?: string;
  layout?: WorkspaceLayout;
}

export interface SaveWorkspaceTask {
  id: string;
  name: string;
  kind: TaskKind;
  config: TaskConfig;
}

export interface SaveWorkspaceRequest {
  layout: WorkspaceLayout;
  tasks: SaveWorkspaceTask[];
}

export interface SaveWorkspaceResponse {
  workspace: Workspace;
  tasks: TaskDefinition[];
}
