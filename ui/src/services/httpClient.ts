import { beginGlobalLoading, endGlobalLoading } from "@/lib/globalLoading";
import { redirectToLogin } from "@/lib/navigation";

export class HttpError extends Error {
  readonly silent: boolean;

  constructor(
    public readonly status: number,
    message: string,
    options?: { silent?: boolean },
  ) {
    super(message);
    this.silent = options?.silent ?? false;
  }
}

export function isChipNameConflict(error: unknown): boolean {
  return error instanceof HttpError
    && error.status === 409
    && error.message === "chip name already exists";
}

export function isScheduleNameConflict(error: unknown): boolean {
  return error instanceof HttpError
    && error.status === 409
    && error.message === "schedule name already exists";
}

export function isWorkspaceVersionConflict(error: unknown): boolean {
  return error instanceof HttpError
    && error.status === 409
    && error.message === "workspace has changed, reload and save again";
}

export type HttpRequestInit = RequestInit & {
  /** When true, does not show the global loading overlay. */
  silent?: boolean;
  /** When true, shows the overlay immediately instead of waiting for the delay. */
  immediate?: boolean;
};

function requestHeaders(init: RequestInit): Headers {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

function errorFromBody(status: number, statusText: string, data: unknown, fallback: string): HttpError {
  const message =
    data && typeof data === "object" && "error" in data && typeof data.error === "string"
      ? data.error
      : fallback || statusText;
  return new HttpError(status, message);
}

export async function httpRequest<T>(path: string, init: HttpRequestInit = {}): Promise<T> {
  const { silent, immediate, ...fetchInit } = init;
  const headers = requestHeaders(fetchInit);

  if (!silent) beginGlobalLoading(immediate);
  try {
    const response = await fetch(path, {
      ...fetchInit,
      headers,
      credentials: "include",
    });

    if (response.status === 401 && !path.endsWith("/api/login")) {
      redirectToLogin();
      throw new HttpError(401, "unauthorized", { silent: true });
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
      throw errorFromBody(response.status, response.statusText, data, response.statusText);
    }

    return data as T;
  } finally {
    if (!silent) endGlobalLoading();
  }
}

export async function httpNdjson(
  path: string,
  init: HttpRequestInit,
  onEvent: (event: unknown) => void,
): Promise<void> {
  const { silent, immediate, ...fetchInit } = init;
  const headers = requestHeaders(fetchInit);

  if (!silent) beginGlobalLoading(immediate);
  try {
    const response = await fetch(path, {
      ...fetchInit,
      headers,
      credentials: "include",
    });

    if (response.status === 401 && !path.endsWith("/api/login")) {
      redirectToLogin();
      throw new HttpError(401, "unauthorized", { silent: true });
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.includes("ndjson")) {
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
        throw errorFromBody(response.status, response.statusText, data, response.statusText);
      }
      onEvent(data);
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new HttpError(response.status, "empty body");
    }
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      buf += decoder.decode(value, { stream: !done });
      let newline = buf.indexOf("\n");
      while (newline >= 0) {
        const line = buf.slice(0, newline).trim();
        buf = buf.slice(newline + 1);
        if (line) onEvent(JSON.parse(line) as unknown);
        newline = buf.indexOf("\n");
      }
      if (done) {
        const line = buf.trim();
        if (line) onEvent(JSON.parse(line) as unknown);
        break;
      }
    }
  } finally {
    if (!silent) endGlobalLoading();
  }
}
