export type UserRole = "admin" | "operator" | "analyst" | "viewer";

export interface SessionUser {
  id: string;
  userid: string;
  username: string;
  avatar_data_url?: string | null;
  active: boolean;
  roles: string[];
  permissions: string[];
  created_at: string;
  updated_at: string;
}

export interface RoleRecord {
  id: string;
  code: string;
  name: string;
  description: string | null;
  permissions: string[];
  created_at: string;
  updated_at: string;
}

export interface PermissionRecord {
  id: string;
  code: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserListResponse {
  users: SessionUser[];
}

export interface RoleListResponse {
  roles: RoleRecord[];
}

export interface PermissionListResponse {
  permissions: PermissionRecord[];
}

export interface CreateUserRequest {
  userid: string;
  username: string;
  password: string;
  roles: string[];
}

export interface UpdateUserRequest {
  username?: string;
  password?: string;
  roles?: string[];
  active?: boolean;
}
