import { httpRequest } from "@/services/httpClient";
import type {
  CreateUserRequest,
  PermissionListResponse,
  RoleListResponse,
  SessionUser,
  UpdateUserRequest,
  UserListResponse,
} from "@/types/user";
import type { ApiSuccess } from "@/types/api";

export const userApi = {
  me: () => httpRequest<SessionUser>("/api/me", { silent: true }),
  updateProfile: (username: string, avatarDataUrl: string | null) =>
    httpRequest<SessionUser>("/api/me/profile", {
      method: "PATCH",
      body: JSON.stringify({ username, avatar_data_url: avatarDataUrl }),
    }),
  changePassword: (currentPassword: string, newPassword: string) =>
    httpRequest<ApiSuccess>("/api/me/password", {
      method: "PATCH",
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    }),
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
