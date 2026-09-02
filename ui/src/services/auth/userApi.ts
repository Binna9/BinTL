import { httpRequest } from "@/services/httpClient";
import type {
  CreateUserRequest,
  PermissionListResponse,
  RoleListResponse,
  SessionUser,
  UpdateUserRequest,
  UserListResponse,
} from "@/types/user";

export const userApi = {
  me: () => httpRequest<SessionUser>("/api/me", { silent: true }),
  list: () => httpRequest<UserListResponse>("/api/users"),
  create: (body: CreateUserRequest) =>
    httpRequest<SessionUser>("/api/users", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (id: string, body: UpdateUserRequest) =>
    httpRequest<SessionUser>(`/api/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  roles: () => httpRequest<RoleListResponse>("/api/roles"),
  permissions: () => httpRequest<PermissionListResponse>("/api/permissions"),
};
