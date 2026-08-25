export type TaskKind = "extract" | "transform" | "load";

export type TaskConfig = Record<string, unknown>;

export interface TaskDefinition {
  id: string;
  workspace_id: string;
  name: string;
  kind: TaskKind;
  config: TaskConfig;
  revision: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface TaskRun {
  id: string;
  task_id: string;
  workspace_id: string;
  kind: TaskKind;
  status: string;
  config_snapshot: TaskConfig;
  input_dataset_id?: string | null;
  output_dataset_id?: string | null;
  error_message?: string | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface TaskListResponse {
  tasks: TaskDefinition[];
}

export interface TaskRunListResponse {
  runs: TaskRun[];
}

export interface TaskRunLogsResponse {
  id: string;
  text: string;
}

export interface SaveTaskRequest {
  name: string;
  kind: TaskKind;
  config: TaskConfig;
}

export interface UpdateTaskRequest {
  name?: string;
  kind?: TaskKind;
  config?: TaskConfig;
  active?: boolean;
}

export interface RunTaskRequest {
  input_dataset_id?: string;
}

export interface RunTaskResponse {
  ok: boolean;
  id: string;
  status: string;
  run: TaskRun;
}
