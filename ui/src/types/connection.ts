export type HttpAuthMode = "none" | "basic" | "bearer" | "api_key" | "custom";

export interface HttpAuthConfig {
  mode: HttpAuthMode;
  api_key_name?: string;
  api_key_location?: "header" | "query";
  login_path?: string;
  login_body_mode?: "json" | "urlencoded";
  username_field?: string;
  password_field?: string;
  access_token_path?: string;
  token_header?: string;
  token_prefix?: string;
  refresh_path?: string;
  refresh_token_path?: string;
  refresh_field?: string;
  refresh_body_mode?: "json" | "urlencoded" | "header";
}

export interface DataConnection {
  id: string;
  name: string;
  driver: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  ssl: number;
  created_at: string;
  http_auth?: HttpAuthConfig | null;
}

export interface CreateConnectionRequest {
  name: string;
  driver: string;
  host: string;
  port?: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
  http_auth?: HttpAuthConfig;
}

export const HTTP_AUTH_MODES: HttpAuthMode[] = ["none", "bearer", "basic", "api_key", "custom"];

export function inferredHttpAuthMode(connection: Pick<DataConnection, "username" | "http_auth">): HttpAuthMode {
  const mode = connection.http_auth?.mode;
  if (mode === "none" || mode === "basic" || mode === "bearer" || mode === "api_key" || mode === "custom") {
    return mode;
  }
  return connection.username.trim() ? "basic" : "bearer";
}

function formValue(form: HTMLFormElement, name: string): string {
  return (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null)?.value ?? "";
}

export function httpAuthFromForm(form: HTMLFormElement, driver: string): HttpAuthConfig | undefined {
  if (driver !== "http") return undefined;
  const mode = (formValue(form, "http_auth_mode") || "none") as HttpAuthMode;
  const auth: HttpAuthConfig = { mode };
  if (mode === "api_key") {
    auth.api_key_name = formValue(form, "api_key_name").trim() || "X-API-Key";
    auth.api_key_location = formValue(form, "api_key_location") === "query" ? "query" : "header";
  }
  if (mode === "custom") {
    auth.login_path = formValue(form, "login_path").trim() || "/auth/login";
    auth.login_body_mode = formValue(form, "login_body_mode") === "urlencoded" ? "urlencoded" : "json";
    auth.username_field = formValue(form, "username_field").trim() || "email";
    auth.password_field = formValue(form, "password_field").trim() || "password";
    auth.access_token_path = formValue(form, "access_token_path").trim() || "data.accessToken";
    auth.token_header = formValue(form, "token_header").trim() || "Authorization";
    auth.token_prefix = formValue(form, "token_prefix").trim() || "Bearer";
    auth.refresh_path = formValue(form, "refresh_path").trim();
    if (auth.refresh_path) {
      auth.refresh_token_path = formValue(form, "refresh_token_path").trim() || "data.refreshToken";
      auth.refresh_field = formValue(form, "refresh_field").trim() || "refreshToken";
      const refreshMode = formValue(form, "refresh_body_mode");
      auth.refresh_body_mode =
        refreshMode === "urlencoded" || refreshMode === "header" ? refreshMode : "json";
    }
  }
  return auth;
}

export function httpUsernameFromForm(form: HTMLFormElement, driver: string): string {
  const username = formValue(form, "username");
  if (driver !== "http") return username;
  const mode = formValue(form, "http_auth_mode");
  return mode === "basic" || mode === "custom" ? username : "";
}

export interface DatabaseColumn {
  name: string;
  data_type: string;
  nullable: boolean;
  ordinal?: number;
  primary_key?: boolean;
  default_value?: string | null;
  max_length?: number | null;
  numeric_precision?: number | null;
  numeric_scale?: number | null;
  extra?: string | null;
  comment?: string | null;
}

export interface TablePreview {
  table: string;
  limit: number;
  columns: string[];
  rows: string[][];
}

export interface CatalogEntry {
  name: string;
  kind: "database" | "schema" | "table" | "view";
  current?: boolean | null;
}

export type CatalogLayout = "database.schema.table" | "database.table";

export interface CatalogSelection {
  database: string;
  schema: string | null;
  table: string;
  qualified: string;
}
