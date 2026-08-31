import { beginGlobalLoading, endGlobalLoading } from "@/lib/globalLoading";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type HttpRequestInit = RequestInit & {
  /** When true, does not show the global loading overlay. */
  silent?: boolean;
};

export async function httpRequest<T>(path: string, init: HttpRequestInit = {}): Promise<T> {
  const { silent, ...fetchInit } = init;
  const headers = new Headers(fetchInit.headers);
  if (fetchInit.body && !(fetchInit.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (!silent) beginGlobalLoading();
  try {
    const response = await fetch(path, {
      ...fetchInit,
      headers,
      credentials: "include",
    });

    if (response.status === 401 && !path.endsWith("/api/login")) {
      if (location.pathname !== "/login") location.assign("/login");
      throw new HttpError(401, "unauthorized");
    }

    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        throw new HttpError(response.status, text.trim() || response.statusText);
      }
    }

    if (!response.ok) {
      const message =
        data && typeof data === "object" && "error" in data && typeof data.error === "string"
          ? data.error
          : response.statusText;
      throw new HttpError(response.status, message);
    }

    return data as T;
  } finally {
    if (!silent) endGlobalLoading();
  }
}
