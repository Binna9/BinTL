import { httpRequest } from "@/services/httpClient";
import type { ApiSuccess } from "@/types/api";

export const authApi = {
  login: (userid: string, password: string) =>
    httpRequest<ApiSuccess>("/api/login", {
      method: "POST",
      body: JSON.stringify({ userid, password }),
    }),
  logout: () => httpRequest<ApiSuccess>("/api/logout", { method: "POST" }),
};
