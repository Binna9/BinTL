import { FormEvent, useMemo, useState, type ReactNode } from "react";
import { Braces, CircleCheck, Database, KeyRound, Maximize2, Pencil, PlugZap, Save, Trash2, X } from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { CatalogTree } from "@/components/connections/CatalogTree";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { SplitLayout } from "@/layouts/SplitLayout";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { PaneHeader } from "@/components/ui/pane-header";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { useConnections } from "@/hooks/connections/useConnections";
import { useSession } from "@/hooks/auth/useSession";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { layout } from "@/lib/layout";
import { toastDeleteError, toastError, toastSuccess, showConfirm } from "@/lib/notifications";
import { selectableClass } from "@/lib/selectable";
import { driverCatalog } from "@/mock/driverCatalog";
import { connectionApi } from "@/services/connections/connectionApi";
import {
  HTTP_AUTH_MODES,
  httpAuthFromForm,
  httpUsernameFromForm,
  inferredHttpAuthMode,
  type CatalogSelection,
  type DataConnection,
  type DatabaseColumn,
  type HttpAuthConfig,
  type HttpAuthMode,
} from "@/types/connection";

function dash(value?: string | null): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "—";
}

function authModeLabel(
  messages: ReturnType<typeof useLanguage>["messages"],
  mode: HttpAuthMode,
): string {
  const page = messages.connectionsPage;
  if (mode === "none") return page.authNone;
  if (mode === "bearer") return page.authBearer;
  if (mode === "basic") return page.authBasic;
  if (mode === "api_key") return page.authApiKey;
  return page.authCustom;
}

type AppliedHttpAuth = {
  mode: HttpAuthMode;
  username: string;
  password: string;
  http_auth: HttpAuthConfig;
  secretSet: boolean;
};

function appliedFromConnection(connection: DataConnection): AppliedHttpAuth {
  const mode = inferredHttpAuthMode(connection);
  return {
    mode,
    username: connection.username,
    password: "",
    http_auth: connection.http_auth ?? { mode },
    secretSet: mode !== "none",
  };
}

function attachPreview(
  page: ReturnType<typeof useLanguage>["messages"]["connectionsPage"],
  applied: AppliedHttpAuth,
): string {
  const auth = applied.http_auth;
  if (applied.mode === "none") return page.authPreviewNone;
  if (applied.mode === "bearer") return page.authPreviewBearer;
  if (applied.mode === "basic") return page.authPreviewBasic;
  if (applied.mode === "api_key") {
    const name = auth.api_key_name?.trim() || "X-API-Key";
    return auth.api_key_location === "query"
      ? page.authPreviewApiKeyQuery(name)
      : page.authPreviewApiKeyHeader(name);
  }
  return [
    page.authPreviewLogin,
    (auth.login_body_mode === "urlencoded" ? page.authPreviewLoginForm : page.authPreviewLoginJson)(
      auth.login_path ?? "",
      auth.username_field ?? "",
      auth.password_field ?? "",
    ),
    page.authPreviewThen,
    page.authPreviewToken(auth.token_header ?? "", auth.token_prefix ?? "", auth.access_token_path ?? ""),
  ].join("\n");
}

function AppliedAuthSummary({
  applied,
  messages,
}: {
  applied: AppliedHttpAuth | null;
  messages: ReturnType<typeof useLanguage>["messages"];
}) {
  const page = messages.connectionsPage;
  if (!applied) {
    return <p className="text-xs leading-5 text-text-tertiary">{page.authNotApplied}</p>;
  }
  const rows: Array<[string, string]> = [[page.authMode, authModeLabel(messages, applied.mode)]];
  if (applied.mode === "basic" || applied.mode === "custom") {
    rows.push([applied.mode === "custom" ? page.customUser : page.username, dash(applied.username)]);
  }
  if (applied.mode !== "none") {
    rows.push([
      applied.mode === "bearer" ? page.bearerToken : applied.mode === "api_key" ? page.apiSecret : page.password,
      applied.secretSet || applied.password ? page.authSecretSet : page.authSecretEmpty,
    ]);
  }
  if (applied.mode === "api_key") {
    rows.push([page.apiKeyName, applied.http_auth.api_key_name?.trim() || "X-API-Key"]);
    rows.push([
      page.apiKeyLocation,
      applied.http_auth.api_key_location === "query" ? page.apiKeyQuery : page.apiKeyHeader,
    ]);
  }
  if (applied.mode === "custom") {
    rows.push([page.loginPath, applied.http_auth.login_path?.trim() || "/auth/login"]);
  }
  return (
    <div className="min-w-0 space-y-3">
      <dl className="space-y-2">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-[11px] font-semibold text-text-tertiary">{label}</dt>
            <dd className="mt-0.5 break-all text-sm text-text">{value}</dd>
          </div>
        ))}
      </dl>
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-text-tertiary">
          {page.authAttached}
        </p>
        <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-4 text-text">
          {attachPreview(page, applied)}
        </pre>
      </div>
    </div>
  );
}

function authGuide(page: ReturnType<typeof useLanguage>["messages"]["connectionsPage"], mode: HttpAuthMode) {
  if (mode === "none") return { when: page.authWhenNone, does: page.authDoesNone };
  if (mode === "bearer") return { when: page.authWhenBearer, does: page.authDoesBearer };
  if (mode === "basic") return { when: page.authWhenBasic, does: page.authDoesBasic };
  if (mode === "api_key") return { when: page.authWhenApiKey, does: page.authDoesApiKey };
  return { when: page.authWhenCustom, does: page.authDoesCustom };
}

function AuthField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-text-secondary">{label}</span>
      {hint ? <span className="text-[11px] leading-4 text-text-tertiary">{hint}</span> : null}
      {children}
    </div>
  );
}

function AuthStep({
  step,
  title,
  hint,
  children,
}: {
  step: number;
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/80 bg-surface p-3">
      <div>
        <p className="text-[12px] font-semibold text-text">
          <span className="mr-1.5 tabular-nums text-accent">{step}.</span>
          {title}
        </p>
        <p className="mt-1 text-[11px] leading-4 text-text-tertiary">{hint}</p>
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

function HttpAuthFields({
  mode,
  onModeChange,
  defaults,
  username,
  keepPassword,
  messages,
}: {
  mode: HttpAuthMode;
  onModeChange: (mode: HttpAuthMode) => void;
  defaults?: HttpAuthConfig | null;
  username?: string;
  keepPassword?: boolean;
  messages: ReturnType<typeof useLanguage>["messages"];
}) {
  const page = messages.connectionsPage;
  const guide = authGuide(page, mode);
  const [apiKeyName, setApiKeyName] = useState(defaults?.api_key_name ?? "X-API-Key");
  const [apiKeyLocation, setApiKeyLocation] = useState(
    defaults?.api_key_location === "query" ? "query" : "header",
  );
  const [loginPath, setLoginPath] = useState(defaults?.login_path ?? "/auth/login");
  const [loginBodyMode, setLoginBodyMode] = useState(
    defaults?.login_body_mode === "urlencoded" ? "urlencoded" : "json",
  );
  const [usernameField, setUsernameField] = useState(defaults?.username_field ?? "email");
  const [passwordField, setPasswordField] = useState(defaults?.password_field ?? "password");
  const [accessTokenPath, setAccessTokenPath] = useState(
    defaults?.access_token_path ?? "data.accessToken",
  );
  const [tokenHeader, setTokenHeader] = useState(defaults?.token_header ?? "Authorization");
  const [tokenPrefix, setTokenPrefix] = useState(defaults?.token_prefix ?? "Bearer");
  const userLabel = mode === "custom" ? page.customUser : page.username;
  const secretLabel =
    mode === "bearer" ? page.bearerToken : mode === "api_key" ? page.apiSecret : mode === "custom" ? page.customPassword : page.password;
  const secretHint =
    mode === "bearer" ? page.bearerTokenHint : mode === "custom" ? page.customUserHint : page.passwordHint;
  const attached =
    mode === "none"
      ? page.authPreviewNone
      : mode === "bearer"
        ? page.authPreviewBearer
        : mode === "basic"
          ? page.authPreviewBasic
          : mode === "api_key"
            ? apiKeyLocation === "query"
              ? page.authPreviewApiKeyQuery(apiKeyName.trim() || "X-API-Key")
              : page.authPreviewApiKeyHeader(apiKeyName.trim() || "X-API-Key")
            : null;
  return (
    <div className="col-span-full flex min-w-0 flex-col gap-3">
      <AuthField label={page.authMode} hint={page.authHint}>
        <Select
          name="http_auth_mode"
          value={mode}
          options={HTTP_AUTH_MODES.map((value) => ({
            value,
            label: authModeLabel(messages, value),
          }))}
          onChange={(value) => onModeChange(value as HttpAuthMode)}
        />
      </AuthField>
      <div className="rounded-lg border border-accent/20 bg-accent-subtle/70 px-3 py-2.5">
        <p className="text-[12px] font-medium text-text">{guide.when}</p>
        <p className="mt-1 text-[11px] leading-4 text-text-secondary">{guide.does}</p>
        <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-tertiary">
          {page.authAttached}
        </p>
        {mode === "custom" ? (
          <div className="mt-1.5 space-y-2">
            <div>
              <p className="text-[10px] font-medium text-text-tertiary">{page.authPreviewLogin}</p>
              <pre className="mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px] leading-4 text-text">
                {(loginBodyMode === "urlencoded" ? page.authPreviewLoginForm : page.authPreviewLoginJson)(
                  loginPath.trim(),
                  usernameField.trim(),
                  passwordField.trim(),
                )}
              </pre>
            </div>
            <div>
              <p className="text-[10px] font-medium text-text-tertiary">{page.authPreviewThen}</p>
              <pre className="mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px] leading-4 text-text">
                {page.authPreviewToken(tokenHeader.trim(), tokenPrefix.trim(), accessTokenPath.trim())}
              </pre>
            </div>
          </div>
        ) : (
          <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-4 text-text">
            {attached}
          </pre>
        )}
      </div>
      {mode === "basic" || mode === "custom" ? (
        <AuthField label={userLabel} hint={mode === "custom" ? page.customUserHint : undefined}>
          <input
            className="field-control"
            name="username"
            autoComplete="off"
            defaultValue={username}
            placeholder={mode === "custom" ? "user@example.com" : page.usernamePlaceholder}
          />
        </AuthField>
      ) : null}
      {mode !== "none" && mode !== "custom" ? (
        <AuthField label={secretLabel} hint={keepPassword ? page.passwordKeep : secretHint}>
          <input
            className="field-control"
            name="password"
            type="password"
            autoComplete="new-password"
            placeholder={keepPassword ? page.passwordKeep : page.passwordPlaceholder}
          />
        </AuthField>
      ) : null}
      {mode === "api_key" ? (
        <>
          <AuthField label={page.apiKeyName} hint={`${page.apiKeyNameHint}. ${page.examplePrefix} X-API-Key`}>
            <input
              className="field-control technical"
              name="api_key_name"
              value={apiKeyName}
              onChange={(event) => setApiKeyName(event.target.value)}
            />
          </AuthField>
          <AuthField label={page.apiKeyLocation}>
            <Select
              name="api_key_location"
              value={apiKeyLocation}
              options={[
                { value: "header", label: page.apiKeyHeader },
                { value: "query", label: page.apiKeyQuery },
              ]}
              onChange={setApiKeyLocation}
            />
          </AuthField>
        </>
      ) : null}
      {mode === "custom" ? (
        <>
          <AuthField label={page.customPassword} hint={keepPassword ? page.passwordKeep : undefined}>
            <input
              className="field-control"
              name="password"
              type="password"
              autoComplete="new-password"
              placeholder={keepPassword ? page.passwordKeep : page.passwordPlaceholder}
            />
          </AuthField>
          <AuthStep step={1} title={page.customStepLogin} hint={page.customStepLoginHint}>
            <AuthField label={page.loginPath} hint={page.loginPathHint}>
              <input
                className="field-control technical"
                name="login_path"
                value={loginPath}
                placeholder="/auth/login"
                onChange={(event) => setLoginPath(event.target.value)}
              />
            </AuthField>
            <AuthField label={page.loginBodyMode}>
              <Select
                name="login_body_mode"
                value={loginBodyMode}
                options={[
                  { value: "json", label: "JSON" },
                  { value: "urlencoded", label: "urlencoded" },
                ]}
                onChange={setLoginBodyMode}
              />
            </AuthField>
          </AuthStep>
          <AuthStep step={2} title={page.customStepFields} hint={page.customStepFieldsHint}>
            <AuthField label={page.usernameField} hint={`${page.usernameFieldHint}. ${page.examplePrefix} email`}>
              <input
                className="field-control technical"
                name="username_field"
                value={usernameField}
                onChange={(event) => setUsernameField(event.target.value)}
              />
            </AuthField>
            <AuthField label={page.passwordField} hint={`${page.passwordFieldHint}. ${page.examplePrefix} password`}>
              <input
                className="field-control technical"
                name="password_field"
                value={passwordField}
                onChange={(event) => setPasswordField(event.target.value)}
              />
            </AuthField>
          </AuthStep>
          <AuthStep step={3} title={page.customStepToken} hint={page.customStepTokenHint}>
            <AuthField
              label={page.accessTokenPath}
              hint={`${page.accessTokenPathHint}. ${page.examplePrefix} data.accessToken`}
            >
              <input
                className="field-control technical"
                name="access_token_path"
                value={accessTokenPath}
                onChange={(event) => setAccessTokenPath(event.target.value)}
              />
            </AuthField>
            <AuthField label={page.tokenHeader} hint={`${page.examplePrefix} Authorization`}>
              <input
                className="field-control technical"
                name="token_header"
                value={tokenHeader}
                onChange={(event) => setTokenHeader(event.target.value)}
              />
            </AuthField>
            <AuthField label={page.tokenPrefix} hint={`${page.examplePrefix} Bearer`}>
              <input
                className="field-control technical"
                name="token_prefix"
                value={tokenPrefix}
                onChange={(event) => setTokenPrefix(event.target.value)}
              />
            </AuthField>
          </AuthStep>
          <details className="rounded-lg border border-border/80 bg-surface px-3 py-2">
            <summary className="cursor-pointer text-[12px] font-semibold text-text">
              {page.customStepRefresh}
            </summary>
            <p className="mt-1 text-[11px] leading-4 text-text-tertiary">{page.customStepRefreshHint}</p>
            <div className="mt-3 flex flex-col gap-3">
              <AuthField label={page.refreshPath} hint={page.refreshOptional}>
                <input
                  className="field-control technical"
                  name="refresh_path"
                  defaultValue={defaults?.refresh_path ?? ""}
                />
              </AuthField>
              <AuthField label={page.refreshTokenPath}>
                <input
                  className="field-control technical"
                  name="refresh_token_path"
                  defaultValue={defaults?.refresh_token_path ?? "data.refreshToken"}
                />
              </AuthField>
              <AuthField label={page.refreshField}>
                <input
                  className="field-control technical"
                  name="refresh_field"
                  defaultValue={defaults?.refresh_field ?? "refreshToken"}
                />
              </AuthField>
              <AuthField label={page.refreshBodyMode}>
                <Select
                  name="refresh_body_mode"
                  defaultValue={
                    defaults?.refresh_body_mode === "urlencoded" || defaults?.refresh_body_mode === "header"
                      ? defaults.refresh_body_mode
                      : "json"
                  }
                  options={[
                    { value: "json", label: "JSON" },
                    { value: "urlencoded", label: "urlencoded" },
                    { value: "header", label: "header" },
                  ]}
                />
              </AuthField>
            </div>
          </details>
        </>
      ) : null}
    </div>
  );
}


function ConnectionColumnsGrid({
  columns,
  messages,
}: {
  columns: DatabaseColumn[];
  messages: ReturnType<typeof useLanguage>["messages"];
}) {
  return (
    <DataGrid className="h-full min-h-0" headers={[...messages.connectionsPage.columnHeaders]}>
      {columns.length === 0 ? (
        <EmptyGridRow
          cols={messages.connectionsPage.columnHeaders.length}
          text={messages.query.columnsHint}
        />
      ) : (
        columns.map((column, index) => (
          <GridRow key={column.name}>
            <GridCell mono muted>{column.ordinal ?? index + 1}</GridCell>
            <GridCell mono>{column.name}</GridCell>
            <GridCell mono muted>{column.data_type}</GridCell>
            <GridCell muted>
              {column.nullable ? messages.common.yes : messages.common.no}
            </GridCell>
            <GridCell muted>
              {column.primary_key ? messages.common.yes : messages.common.no}
            </GridCell>
            <GridCell mono muted>{dash(column.default_value)}</GridCell>
            <GridCell muted>{dash(column.comment)}</GridCell>
            <GridCell mono muted>{dash(column.extra)}</GridCell>
          </GridRow>
        ))
      )}
    </DataGrid>
  );
}

export function ConnectionsPage() {
  const { messages } = useLanguage();
  const { canWriteConnections } = useSession();
  const { connections, refreshConnections } = useConnections();
  const [saving, setSaving] = useState(false);
  const [newDriver, setNewDriver] = useState("postgres");
  const [newAuthMode, setNewAuthMode] = useState<HttpAuthMode>("bearer");
  const [editAuthMode, setEditAuthMode] = useState<HttpAuthMode>("bearer");
  const [newAppliedAuth, setNewAppliedAuth] = useState<AppliedHttpAuth | null>(null);
  const [editAppliedAuth, setEditAppliedAuth] = useState<AppliedHttpAuth | null>(null);
  const [authDialog, setAuthDialog] = useState<"create" | "edit" | null>(null);
  const [browseId, setBrowseId] = useState("");
  const [selected, setSelected] = useState<CatalogSelection | null>(null);
  const [columns, setColumns] = useState<DatabaseColumn[]>([]);
  const [editing, setEditing] = useState<DataConnection | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [testingId, setTestingId] = useState("");
  const [testStatus, setTestStatus] = useState<Record<string, "ok" | "fail">>({});
  const [columnsExpanded, setColumnsExpanded] = useState(false);

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const field = (name: string) =>
      form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
    const driver = field("driver").value;
    const value = (name: string) =>
      (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null)?.value ?? "";
    const port = value("port");

    setSaving(true);
    try {
      await connectionApi.createConnection({
        name: field("name").value,
        driver: field("driver").value,
        host: field("host").value,
        port: driver === "http" ? undefined : port ? Number(port) : undefined,
        database: driver === "http" ? "" : value("database"),
        username: driver === "http" ? newAppliedAuth?.username ?? "" : value("username"),
        password: driver === "http" ? newAppliedAuth?.password ?? "" : value("password"),
        ssl:
          driver === "http"
            ? field("host").value.trim().startsWith("https")
            : (field("ssl") as HTMLInputElement).checked,
        http_auth: driver === "http" ? newAppliedAuth?.http_auth ?? { mode: "none" } : undefined,
      });
      form.reset();
      setNewAuthMode("bearer");
      setNewAppliedAuth(null);
      await refreshConnections();
      toastSuccess(messages.connectionsPage.saved);
    } catch (err) {
      toastError(messages.errors.saveConnection, err);
    } finally {
      setSaving(false);
    }
  }

  function onApplyAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const http_auth = httpAuthFromForm(form, "http") ?? { mode: "none" as const };
    const password = (form.elements.namedItem("password") as HTMLInputElement | null)?.value ?? "";
    const previous = authDialog === "edit" ? editAppliedAuth : newAppliedAuth;
    const applied: AppliedHttpAuth = {
      mode: http_auth.mode,
      username: httpUsernameFromForm(form, "http"),
      password: password || previous?.password || "",
      http_auth,
      secretSet: Boolean(password) || (http_auth.mode !== "none" && Boolean(previous?.secretSet)),
    };
    if (authDialog === "edit") {
      setEditAppliedAuth(applied);
      setEditAuthMode(applied.mode);
    } else {
      setNewAppliedAuth(applied);
      setNewAuthMode(applied.mode);
    }
    setAuthDialog(null);
  }

  async function onTest(id: string) {
    setTestingId(id);
    try {
      await connectionApi.testConnection(id);
      setTestStatus((current) => ({ ...current, [id]: "ok" }));
    } catch (err) {
      setTestStatus((current) => ({ ...current, [id]: "fail" }));
      toastError(messages.errors.testConnection, err);
    } finally {
      setTestingId("");
    }
  }

  async function onUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const form = event.currentTarget;
    const field = (name: string) =>
      form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
    const driver = field("driver").value;
    const value = (name: string) =>
      (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null)?.value ?? "";
    const port = driver === "http" ? "" : value("port");

    setEditSaving(true);
    try {
      await connectionApi.updateConnection(editing.id, {
        name: field("name").value,
        driver: field("driver").value,
        host: field("host").value,
        port: port ? Number(port) : undefined,
        database: driver === "http" ? "" : value("database"),
        username: driver === "http" ? editAppliedAuth?.username ?? "" : value("username"),
        password: driver === "http" ? editAppliedAuth?.password ?? "" : value("password"),
        ssl:
          driver === "http"
            ? field("host").value.trim().startsWith("https")
            : (field("ssl") as HTMLInputElement).checked,
        http_auth: driver === "http" ? editAppliedAuth?.http_auth ?? { mode: "none" } : undefined,
      });
      setEditing(null);
      setEditAppliedAuth(null);
      setAuthDialog(null);
      await refreshConnections();
    } catch (err) {
      toastError(messages.errors.saveConnection, err);
    } finally {
      setEditSaving(false);
    }
  }

  async function onBrowse(id: string) {
    if (browseId === id) {
      setBrowseId("");
      setSelected(null);
      setColumns([]);
      setColumnsExpanded(false);
      return;
    }
    setBrowseId(id);
    setSelected(null);
    setColumns([]);
    setColumnsExpanded(false);
  }

  async function onSelectTable(pick: CatalogSelection | null) {
    if (!pick) {
      setSelected(null);
      setColumns([]);
      setColumnsExpanded(false);
      return;
    }
    if (!browseId) return;
    setSelected(pick);
    try {
      const columnResult = await connectionApi.getColumns(
        browseId,
        pick.qualified,
        pick.database,
      );
      setColumns(columnResult.columns);
    } catch (err) {
      setColumns([]);
      toastError(messages.errors.tableInfo, err);
    }
  }

  async function onDelete(connection: DataConnection) {
    const confirmed = await showConfirm(
      messages.connectionsPage.deleteConfirmTitle,
      messages.connectionsPage.deleteConfirmMessage(connection.name),
      { tone: "danger", confirmLabel: messages.common.delete },
    );
    if (!confirmed) return;
    try {
      await connectionApi.deleteConnection(connection.id);
      if (browseId === connection.id) {
        setBrowseId("");
        setSelected(null);
        setColumns([]);
        setColumnsExpanded(false);
      }
      await refreshConnections();
    } catch (err) {
      toastDeleteError(messages.errors.deleteConnection, messages.errors.deleteBlocked, err);
    }
  }

  const activeConnection = connections.find((connection) => connection.id === browseId);
  const driverFamily = newDriver === "http" ? "api" : "database";
  const driverOptions = driverCatalog
    .filter((driver) => (driverFamily === "api" ? driver.value === "http" : driver.value !== "http"))
    .map((driver) => ({ value: driver.value, label: driver.label }));
  const connectionGroups = useMemo(
    () => [
      {
        key: "database",
        label: messages.connectionsPage.databaseConnections,
        icon: Database,
        items: connections.filter((connection) => connection.driver !== "http"),
      },
      {
        key: "api",
        label: messages.connectionsPage.apiConnections,
        icon: Braces,
        items: connections.filter((connection) => connection.driver === "http"),
      },
    ],
    [connections, messages.connectionsPage.apiConnections, messages.connectionsPage.databaseConnections],
  );
  const example = (sample: string) =>
    `${messages.connectionsPage.examplePrefix} ${sample}`;

  return (
    <PageShell>
      <PageHeader
        iconName="connections"
        eyebrow={messages.connectionsPage.eyebrow}
        title={messages.connectionsPage.title}
        description={
          canWriteConnections
            ? messages.connectionsPage.description
            : messages.connectionsPage.readOnlyDescription
        }
      />

      {canWriteConnections ? (
      <Panel className="shrink-0">
        <PanelHeader
          title={messages.connectionsPage.new}
          description={messages.connectionsPage.newDescription}
          actions={
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant={driverFamily === "database" ? "secondary" : "quiet"}
                className="gap-1.5"
                onClick={() => {
                  setNewDriver("postgres");
                  setNewAppliedAuth(null);
                  setAuthDialog((current) => (current === "create" ? null : current));
                }}
              >
                <Database className="size-3.5" aria-hidden="true" />
                DB
              </Button>
              <Button
                type="button"
                variant={driverFamily === "api" ? "secondary" : "quiet"}
                className="gap-1.5"
                onClick={() => {
                  setNewDriver("http");
                  setNewAuthMode("bearer");
                  setNewAppliedAuth(null);
                }}
              >
                <Braces className="size-3.5" aria-hidden="true" />
                API
              </Button>
            </div>
          }
        />
        <PanelBody className="py-4">
          <form className="flex flex-col gap-4" autoComplete="off" onSubmit={(event) => void onSave(event)}>
            <div className="grid gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.85fr)]">
              <section className="rounded-xl border border-border bg-subtle/50 p-4">
                <div className="mb-3">
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
                    {messages.connectionsPage.sectionTarget}
                  </h3>
                  <p className="mt-1 text-[11px] leading-4 text-text-tertiary">
                    {messages.connectionsPage.sectionTargetHint}
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-x-3 gap-y-3 sm:grid-cols-2">
                  <FormField
                    label={messages.connectionsPage.name}
                    example={example(messages.connectionsPage.namePlaceholder)}
                  >
                    <input
                      className="field-control"
                      name="name"
                      required
                      autoComplete="off"
                      placeholder={messages.connectionsPage.namePlaceholder}
                    />
                  </FormField>
                  <FormField
                    label={messages.connectionsPage.driver}
                    example={messages.connectionsPage.driverHint}
                  >
                    <Select
                      name="driver"
                      value={newDriver}
                      options={driverOptions}
                      onChange={setNewDriver}
                    />
                  </FormField>
                  <FormField
                    label={newDriver === "http" ? messages.apiExtract.baseUrl : messages.connectionsPage.host}
                    example={example(messages.connectionsPage.hostPlaceholder)}
                    wide={newDriver === "http"}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        className="field-control min-w-0 flex-1"
                        name="host"
                        required
                        autoComplete="off"
                        placeholder={newDriver === "http" ? "https://api.example.com" : messages.connectionsPage.hostPlaceholder}
                      />
                      {newDriver === "http" ? (
                        <Button
                          type="button"
                          variant={newAppliedAuth ? "secondary" : "quiet"}
                          className="shrink-0 gap-1.5"
                          onClick={() => setAuthDialog("create")}
                        >
                          <KeyRound className="size-3.5" aria-hidden="true" />
                          {messages.connectionsPage.authButton}
                        </Button>
                      ) : null}
                    </div>
                  </FormField>
                  {newDriver === "http" ? null : (
                    <>
                      <FormField
                        label={messages.connectionsPage.port}
                        example={example(messages.connectionsPage.portPlaceholder)}
                      >
                        <input
                          className="field-control technical"
                          name="port"
                          inputMode="numeric"
                          placeholder={messages.connectionsPage.portPlaceholder}
                        />
                      </FormField>
                      <FormField
                        label={messages.connectionsPage.database}
                        example={example(messages.connectionsPage.databasePlaceholder)}
                        wide
                      >
                        <input
                          className="field-control"
                          name="database"
                          autoComplete="off"
                          placeholder={messages.connectionsPage.databasePlaceholder}
                        />
                      </FormField>
                    </>
                  )}
                </div>
              </section>

              <section className="flex flex-col rounded-xl border border-border bg-subtle/50 p-4">
                <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
                  {messages.connectionsPage.sectionAuth}
                </h3>
                <div className="grid grid-cols-1 gap-3">
                  {newDriver === "http" ? (
                    <AppliedAuthSummary applied={newAppliedAuth} messages={messages} />
                  ) : (
                    <>
                      <FormField
                        label={messages.connectionsPage.username}
                        example={example(messages.connectionsPage.usernamePlaceholder)}
                      >
                        <input
                          className="field-control"
                          name="username"
                          autoComplete="off"
                          placeholder={messages.connectionsPage.usernamePlaceholder}
                        />
                      </FormField>
                      <FormField
                        label={messages.connectionsPage.password}
                        example={messages.connectionsPage.passwordHint}
                      >
                        <input
                          className="field-control"
                          name="password"
                          type="password"
                          autoComplete="new-password"
                          placeholder={messages.connectionsPage.passwordPlaceholder}
                        />
                      </FormField>
                      <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-surface px-3 py-2.5">
                        <input className="field-control mt-0.5" name="ssl" type="checkbox" />
                        <span className="min-w-0">
                          <span className="block text-xs font-medium text-text">
                            {messages.connectionsPage.useSsl}
                          </span>
                          <span className="mt-0.5 block text-[11px] leading-4 text-text-tertiary">
                            {messages.connectionsPage.sslHint}
                          </span>
                        </span>
                      </label>
                    </>
                  )}
                </div>
                <div className="mt-auto flex justify-end pt-4">
                  <Button variant="primary" type="submit" disabled={saving}>
                    <Save className="size-3.5" aria-hidden="true" />
                    {saving ? messages.common.saving : messages.common.save}
                  </Button>
                </div>
              </section>
            </div>
          </form>
        </PanelBody>
      </Panel>
      ) : null}

      <Panel tall className="overflow-hidden">
        <Toolbar>
          <ToolbarGroup>
            <span className="text-[13px] font-semibold">{messages.connectionsPage.explorer}</span>
            <span className="text-xs text-text-tertiary">
              {activeConnection ? activeConnection.name : messages.connectionsPage.selectConnection}
            </span>
          </ToolbarGroup>
        </Toolbar>

        <SplitLayout className="min-h-0 flex-1" defaultSizes={[layout.split.sidebar]}>
          <aside className="flex h-full min-h-0 flex-col overflow-hidden">
            <PaneHeader title={messages.common.connections} meta={messages.common.count(connections.length)} />
            <div className="scroll-pane min-h-0 flex-1 overflow-y-auto bg-surface">
              {connections.length === 0 ? (
                <p className="p-4 text-xs text-text-tertiary">{messages.empty.connections}</p>
              ) : (
                <div className="space-y-2 p-2">
                  {connectionGroups.map((group) => {
                    const GroupIcon = group.icon;
                    return (
                    <section key={group.key} className="overflow-hidden rounded-lg border border-border bg-surface">
                      <div className="flex items-center gap-2 border-b border-border bg-raised px-3 py-2.5">
                        <GroupIcon className="size-4 text-accent" aria-hidden="true" />
                        <span className="text-xs font-bold text-text">{group.label}</span>
                        <span className="ml-auto text-[11px] font-semibold tabular-nums text-text-tertiary">
                          {group.items.length}
                        </span>
                      </div>
                      {group.items.length === 0 ? (
                        <p className="px-3 py-3 text-[11px] text-text-tertiary">{messages.empty.connections}</p>
                      ) : group.items.map((connection) => (
                    <li
                      key={connection.id}
                      className={cn(
                        "relative border-b border-border p-3",
                        canWriteConnections ? "pr-16" : "pr-3",
                        selectableClass(connection.id === browseId),
                      )}
                    >
                      {canWriteConnections ? (
                      <div className="absolute right-2 top-2 flex gap-0.5">
                        <button
                          type="button"
                          className="grid size-7 place-items-center rounded-md text-text-tertiary outline-none hover:bg-subtle hover:text-text focus-visible:ring-2 focus-visible:ring-accent/40"
                          aria-label={messages.common.edit}
                          title={messages.common.edit}
                          onClick={() => {
                            setEditing(connection);
                            setEditAuthMode(inferredHttpAuthMode(connection));
                            setEditAppliedAuth(
                              connection.driver === "http" ? appliedFromConnection(connection) : null,
                            );
                          }}
                        >
                          <Pencil className="size-3.5" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="grid size-7 place-items-center rounded-md text-text-tertiary outline-none hover:bg-danger-subtle hover:text-danger focus-visible:ring-2 focus-visible:ring-accent/40"
                          aria-label={messages.common.delete}
                          title={messages.common.delete}
                          onClick={() => void onDelete(connection)}
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </button>
                      </div>
                      ) : null}
                      <button
                        type="button"
                        title={connection.name}
                        className="block w-full min-w-0 overflow-hidden text-left"
                        onClick={() => void onBrowse(connection.id)}
                      >
                        <span className="block truncate text-[13px] text-text">{connection.name}</span>
                        <span className="mt-1 block truncate text-[11px] text-text-tertiary">
                          {connection.driver === "http"
                            ? `${authModeLabel(messages, inferredHttpAuthMode(connection))} · ${connection.host}`
                            : `${connection.driver} · ${connection.host}:${connection.port}`}
                        </span>
                      </button>
                      <div className="mt-2 flex items-center gap-2">
                        <Button
                          type="button"
                          variant="quiet"
                          disabled={testingId === connection.id}
                          onClick={() => void onTest(connection.id)}
                        >
                          <PlugZap className="size-3.5" aria-hidden="true" />
                          {testingId === connection.id ? messages.common.running : messages.common.test}
                        </Button>
                        {testStatus[connection.id] === "ok" ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-success">
                            <CircleCheck className="size-3.5" aria-hidden="true" />
                            {messages.connectionsPage.testOk}
                          </span>
                        ) : testStatus[connection.id] === "fail" ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-danger">
                            <X className="size-3.5" aria-hidden="true" />
                            {messages.connectionsPage.testFail}
                          </span>
                        ) : null}
                      </div>
                    </li>
                      ))}
                    </section>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>

          {!activeConnection ? (
            <div className="grid h-full place-items-center text-[13px] text-text-tertiary">
              {messages.connectionsPage.selectConnectionHint}
            </div>
          ) : activeConnection.driver === "http" ? (
            <div className="flex h-full min-w-0 flex-col overflow-hidden">
              <PaneHeader
                title={messages.apiExtract.detailTitle}
                actions={
                  <Button type="button" variant="secondary" onClick={() => setEditing(activeConnection)}>
                    <Pencil className="size-3.5" aria-hidden="true" />
                    {messages.common.edit}
                  </Button>
                }
              />
              <div className="scroll-pane min-h-0 flex-1 overflow-y-auto p-4">
                <div className="mx-auto grid max-w-3xl gap-3 sm:grid-cols-2">
                  <section className="rounded-xl border border-border bg-subtle/40 p-4 sm:col-span-2">
                    <h3 className="mb-3 text-xs font-bold text-text">{messages.apiExtract.apiInfo}</h3>
                    <dl className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <dt className="text-[11px] font-semibold text-text-tertiary">{messages.connectionsPage.name}</dt>
                        <dd className="mt-1 truncate text-sm text-text">{activeConnection.name}</dd>
                      </div>
                      <div>
                        <dt className="text-[11px] font-semibold text-text-tertiary">{messages.apiExtract.baseUrl}</dt>
                        <dd className="mt-1 break-all font-mono text-sm text-text">{activeConnection.host}</dd>
                      </div>
                      <div>
                        <dt className="text-[11px] font-semibold text-text-tertiary">{messages.apiExtract.basicUser}</dt>
                        <dd className="mt-1 text-sm text-text">{dash(activeConnection.username)}</dd>
                      </div>
                      <div>
                        <dt className="text-[11px] font-semibold text-text-tertiary">{messages.apiExtract.token}</dt>
                        <dd className="mt-1 text-sm text-text">••••••••</dd>
                      </div>
                    </dl>
                  </section>
                  <p className="text-xs leading-5 text-text-tertiary sm:col-span-2">
                    {messages.apiExtract.newConnectionHint}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <SplitLayout className="h-full min-w-0" defaultSizes={[layout.split.catalog]}>
              <aside className="flex h-full min-h-0 flex-col overflow-hidden bg-surface">
                <PaneHeader title={messages.common.catalog} />
                <div className="scroll-pane min-h-0 flex-1 overflow-y-auto">
                  <CatalogTree
                    connectionId={activeConnection.id}
                    selected={selected}
                    onPick={(pick) => void onSelectTable(pick)}
                  />
                </div>
              </aside>

              {!selected ? (
                <div className="grid h-full place-items-center text-[13px] text-text-tertiary">
                  {messages.connectionsPage.selectTableHint}
                </div>
              ) : (
                <div className="flex h-full min-w-0 flex-col overflow-hidden">
                  <PaneHeader
                    title={messages.connectionsPage.columnDetails}
                    meta={`${columns.length}`}
                    description={selected.qualified}
                    actions={
                      <Button
                        type="button"
                        variant="secondary"
                        title={messages.connectionsPage.expand}
                        onClick={() => setColumnsExpanded(true)}
                      >
                        <Maximize2 className="size-3.5" aria-hidden="true" />
                        {messages.connectionsPage.expand}
                      </Button>
                    }
                  />
                  <div className="min-h-0 flex-1 overflow-hidden bg-surface">
                    <ConnectionColumnsGrid columns={columns} messages={messages} />
                  </div>
                </div>
              )}
            </SplitLayout>
          )}
        </SplitLayout>
      </Panel>

      <AppDialog
        open={columnsExpanded && Boolean(selected)}
        title={messages.connectionsPage.columnDetails}
        icon={<Maximize2 className="size-4 text-accent" aria-hidden="true" />}
        headerExtra={
          selected ? (
            <span className="truncate text-xs text-text-tertiary">{selected.qualified}</span>
          ) : null
        }
        className="h-[90vh] w-[96vw] max-w-[90rem]"
        minWidth={560}
        minHeight={360}
        onClose={() => setColumnsExpanded(false)}
        footer={
          <Button type="button" variant="secondary" onClick={() => setColumnsExpanded(false)}>
            {messages.common.close}
          </Button>
        }
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface">
          <ConnectionColumnsGrid columns={columns} messages={messages} />
        </div>
      </AppDialog>

      <AppDialog
        open={Boolean(editing)}
        title={messages.connectionsPage.editConnection}
        icon={<Pencil className="size-4 text-accent" aria-hidden="true" />}
        className="w-[min(42rem,94vw)] max-h-[90vh]"
        minWidth={360}
        minHeight={280}
        onClose={() => {
          setEditing(null);
          setEditAppliedAuth(null);
          setAuthDialog((current) => (current === "edit" ? null : current));
        }}
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setEditing(null);
                setEditAppliedAuth(null);
                setAuthDialog((current) => (current === "edit" ? null : current));
              }}
            >
              {messages.common.close}
            </Button>
            <Button
              type="submit"
              form="edit-connection-form"
              variant="primary"
              disabled={editSaving}
            >
              <Save className="size-3.5" aria-hidden="true" />
              {editSaving ? messages.common.saving : messages.common.save}
            </Button>
          </>
        }
      >
        {editing ? (
          <form
            id="edit-connection-form"
            key={editing.id}
            className="scroll-pane grid min-h-0 flex-1 grid-cols-2 content-start gap-3 overflow-auto p-4"
            onSubmit={(event) => void onUpdate(event)}
          >
            <FormField label={messages.connectionsPage.name}>
              <input className="field-control" name="name" defaultValue={editing.name} required />
            </FormField>
            <FormField label={messages.connectionsPage.driver}>
              <Select
                name="driver"
                defaultValue={editing.driver}
                options={driverCatalog.map((driver) => ({
                  value: driver.value,
                  label: driver.label,
                }))}
              />
            </FormField>
            <FormField label={editing.driver === "http" ? messages.apiExtract.baseUrl : messages.connectionsPage.host}>
              <div className="flex items-center gap-2">
                <input className="field-control min-w-0 flex-1" name="host" defaultValue={editing.host} required />
                {editing.driver === "http" ? (
                  <Button
                    type="button"
                    variant="secondary"
                    className="shrink-0 gap-1.5"
                    onClick={() => setAuthDialog("edit")}
                  >
                    <KeyRound className="size-3.5" aria-hidden="true" />
                    {messages.connectionsPage.authButton}
                  </Button>
                ) : null}
              </div>
            </FormField>
            {editing.driver === "http" ? (
              <div className="rounded-lg border border-border bg-subtle/50 p-3">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
                  {messages.connectionsPage.sectionAuth}
                </p>
                <AppliedAuthSummary applied={editAppliedAuth} messages={messages} />
              </div>
            ) : null}
            {editing.driver === "http" ? null : (
              <>
                <FormField label={messages.connectionsPage.port}>
                  <input
                    className="field-control technical"
                    name="port"
                    defaultValue={editing.port || ""}
                    placeholder="5432"
                  />
                </FormField>
                <FormField label={messages.connectionsPage.database} wide>
                  <input
                    className="field-control"
                    name="database"
                    defaultValue={editing.database_name}
                    required
                  />
                </FormField>
              </>
            )}
            {editing.driver === "http" ? null : (
              <>
                <FormField label={messages.connectionsPage.username}>
                  <input className="field-control" name="username" defaultValue={editing.username} />
                </FormField>
                <FormField label={messages.connectionsPage.password}>
                  <input
                    className="field-control"
                    name="password"
                    type="password"
                    placeholder={messages.connectionsPage.passwordKeep}
                  />
                </FormField>
                <label className="col-span-2 flex items-center gap-2 text-xs text-text-secondary">
                  <input
                    className="field-control"
                    name="ssl"
                    type="checkbox"
                    defaultChecked={editing.ssl !== 0}
                  />
                  {messages.connectionsPage.useSsl}
                </label>
              </>
            )}
          </form>
        ) : null}
      </AppDialog>

      <AppDialog
        open={authDialog !== null}
        title={messages.connectionsPage.sectionAuth}
        icon={<KeyRound className="size-4 text-accent" aria-hidden="true" />}
        className="w-[min(32rem,94vw)] max-h-[90vh]"
        minWidth={360}
        minHeight={280}
        zIndex={120}
        onClose={() => setAuthDialog(null)}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setAuthDialog(null)}>
              {messages.common.close}
            </Button>
            <Button type="submit" form="http-auth-dialog-form" variant="primary">
              {messages.connectionsPage.authApply}
            </Button>
          </>
        }
      >
        {authDialog ? (
          <form
            id="http-auth-dialog-form"
            key={`${authDialog}-${authDialog === "edit" ? editing?.id ?? "edit" : "new"}`}
            className="scroll-pane min-h-0 flex-1 overflow-auto p-4"
            onSubmit={onApplyAuth}
          >
            <HttpAuthFields
              mode={authDialog === "edit" ? editAuthMode : newAuthMode}
              onModeChange={authDialog === "edit" ? setEditAuthMode : setNewAuthMode}
              defaults={
                authDialog === "edit"
                  ? editAppliedAuth?.http_auth ?? editing?.http_auth
                  : newAppliedAuth?.http_auth
              }
              username={
                authDialog === "edit"
                  ? editAppliedAuth?.username ?? editing?.username
                  : newAppliedAuth?.username
              }
              keepPassword={authDialog === "edit"}
              messages={messages}
            />
          </form>
        ) : null}
      </AppDialog>
    </PageShell>
  );
}
