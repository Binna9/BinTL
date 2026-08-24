import { httpRequest } from "@/services/httpClient";
import type { ApiSuccess } from "@/types/api";

export const authApi = {
  login: (username: string, password: string) =>
    httpRequest<ApiSuccess>("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => httpRequest<ApiSuccess>("/api/logout", { method: "POST" }),
};
