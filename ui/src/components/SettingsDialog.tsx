import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  Hash,
  KeyRound,
  MessageSquareText,
  Plus,
  Search,
  Settings,
  Shield,
  Users,
} from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { DialogContentTransition } from "@/components/DialogContentTransition";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { SplitLayout } from "@/components/SplitLayout";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { PaneHeader } from "@/components/ui/pane-header";
import { Select } from "@/components/ui/select";
import { Toolbar } from "@/components/ui/toolbar";
import { useLanguage } from "@/i18n/LanguageProvider";
import type { Messages } from "@/i18n/ko";
import { useSession } from "@/hooks/useSession";
import { toastError, toastSuccess } from "@/lib/notifications";
import { userApi } from "@/services/userApi";
import type { PermissionRecord, RoleRecord, SessionUser } from "@/types/user";
import { cn } from "@/lib/cn";
import { layout } from "@/lib/layout";

type PageId = "roles" | "permissions" | "users" | "codes" | "messages";

const PAGES: {
  id: PageId;
  icon: typeof Shield;
  label: (m: Messages) => string;
}[] = [
  { id: "roles", icon: Shield, label: (m) => m.settings.roles },
  { id: "permissions", icon: KeyRound, label: (m) => m.settings.permissions },
  { id: "users", icon: Users, label: (m) => m.settings.users },
  { id: "codes", icon: Hash, label: (m) => m.settings.codes },
  { id: "messages", icon: MessageSquareText, label: (m) => m.settings.messages },
];

function hasQuery(query: string, ...fields: string[]) {
  const needle = query.trim().toLowerCase();
  return !needle || fields.some((field) => field.toLowerCase().includes(needle));
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-[10px] font-medium text-accent">
      {children}
    </span>
  );
}

function SettingsList({
  title,
  description,
  count,
  query,
  onQuery,
  headers,
  children,
  onAdd,
}: {
  title: string;
  description: string;
  count: number;
  query: string;
  onQuery: (value: string) => void;
  headers: readonly string[];
  children: ReactNode;
  onAdd?: () => void;
}) {
  const { messages } = useLanguage();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PaneHeader
        title={title}
        description={description}
        meta={messages.common.count(count)}
        actions={
          onAdd ? (
            <Button type="button" variant="primary" onClick={onAdd}>
              <Plus className="size-3.5" aria-hidden="true" />
              {messages.settings.add}
            </Button>
          ) : null
        }
      />
      <Toolbar>
        <label className="relative block w-64">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-text-tertiary"
            aria-hidden="true"
          />
          <input
            className="h-8 w-full rounded-xl border border-border bg-surface py-0 pl-9 pr-2.5 text-[13px] text-text outline-none placeholder:text-text-tertiary focus:border-accent focus:ring-2 focus:ring-accent/15"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder={messages.settings.searchPlaceholder}
            aria-label={messages.nav.search}
          />
        </label>
      </Toolbar>
      <DataGrid className="min-h-0 flex-1" headers={[...headers]}>
        {children}
      </DataGrid>
    </div>
  );
}

function RolesPage({ query, onQuery }: { query: string; onQuery: (value: string) => void }) {
  const { messages } = useLanguage();
  const [roles, setRoles] = useState<RoleRecord[]>([]);

  useEffect(() => {
    void userApi
      .roles()
      .then((response) => setRoles(response.roles))
      .catch((error) => toastError(messages.errors.roles, error));
  }, [messages]);

  const rows = useMemo(
    () =>
      roles.filter((row) => hasQuery(query, row.code, row.name, row.description ?? "", ...row.permissions)),
    [roles, query],
  );

  return (
    <SettingsList
      title={messages.settings.roles}
      description={messages.settings.rolesDesc}
      count={rows.length}
      query={query}
      onQuery={onQuery}
      headers={messages.settings.roleHeaders}
    >
      {rows.length === 0 ? (
        <EmptyGridRow cols={3} text={messages.settings.empty} />
      ) : (
        rows.map((row) => (
          <GridRow key={row.id}>
            <GridCell mono>{row.code}</GridCell>
            <GridCell>{row.description || row.name}</GridCell>
            <GridCell>
              <span className="inline-flex items-center gap-1">
                {row.permissions.slice(0, 2).map((permission) => (
                  <Chip key={permission}>{permission}</Chip>
                ))}
                {row.permissions.length > 2 ? (
                  <span className="text-[10px] text-text-tertiary">
                    +{row.permissions.length - 2}
                  </span>
                ) : null}
              </span>
            </GridCell>
          </GridRow>
        ))
      )}
    </SettingsList>
  );
}

function PermissionsPage({
  query,
  onQuery,
}: {
  query: string;
  onQuery: (value: string) => void;
}) {
  const { messages } = useLanguage();
  const [permissions, setPermissions] = useState<PermissionRecord[]>([]);

  useEffect(() => {
    void userApi
      .permissions()
      .then((response) => setPermissions(response.permissions))
      .catch((error) => toastError(messages.errors.permissions, error));
  }, [messages]);

  const rows = useMemo(
    () =>
      permissions.filter((row) =>
        hasQuery(query, row.code, row.name, row.description ?? ""),
      ),
    [permissions, query],
  );

  return (
    <SettingsList
      title={messages.settings.permissions}
      description={messages.settings.permissionsDesc}
      count={rows.length}
      query={query}
      onQuery={onQuery}
      headers={messages.settings.permissionHeaders}
    >
      {rows.length === 0 ? (
        <EmptyGridRow cols={2} text={messages.settings.empty} />
      ) : (
        rows.map((row) => (
          <GridRow key={row.id}>
            <GridCell mono>{row.code}</GridCell>
            <GridCell>{row.description || row.name}</GridCell>
          </GridRow>
        ))
      )}
    </SettingsList>
  );
}

function roleLabel(messages: Messages, role: string) {
  if (role === "admin") return messages.settings.roleAdmin;
  if (role === "operator") return messages.settings.roleOperator;
  if (role === "analyst") return messages.settings.roleAnalyst;
  if (role === "viewer") return messages.settings.roleViewer;
  return role;
}

function UsersPage({ query, onQuery }: { query: string; onQuery: (value: string) => void }) {
  const { messages } = useLanguage();
  const { canManageUsers, refresh: refreshSession } = useSession();
  const [users, setUsers] = useState<SessionUser[]>([]);
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [editing, setEditing] = useState<SessionUser | "new" | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const [userResponse, roleResponse] = await Promise.all([userApi.list(), userApi.roles()]);
      setUsers(userResponse.users);
      setRoles(roleResponse.roles);
    } catch (error) {
      toastError(messages.errors.users, error);
    }
  }

  useEffect(() => {
    if (!canManageUsers) return;
    void load();
  }, [canManageUsers, messages]);

  const rows = useMemo(
    () =>
      users.filter((row) =>
        hasQuery(
          query,
          row.userid,
          row.username,
          ...row.roles,
          row.active ? "active" : "inactive",
        ),
      ),
    [users, query],
  );

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const userid = String(form.get("userid") ?? "");
    const username = String(form.get("username") ?? "");
    const password = String(form.get("password") ?? "");
    const role = String(form.get("role") ?? "analyst");
    const active = form.get("active") === "on";
    setSaving(true);
    try {
      if (editing === "new") {
        await userApi.create({ userid, username, password, roles: [role] });
      } else if (editing) {
        await userApi.update(editing.id, {
          username,
          roles: [role],
          active,
          password: password.trim() ? password : undefined,
        });
      }
      toastSuccess(messages.settings.userSaved);
      setEditing(null);
      await load();
      await refreshSession();
    } catch (error) {
      toastError(messages.errors.saveUser, error);
    } finally {
      setSaving(false);
    }
  }

  if (!canManageUsers) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-8 text-sm text-text-secondary">
        {messages.settings.usersForbidden}
      </div>
    );
  }

  return (
    <>
      <SettingsList
        title={messages.settings.users}
        description={messages.settings.usersDesc}
        count={rows.length}
        query={query}
        onQuery={onQuery}
        headers={messages.settings.userHeaders}
        onAdd={() => setEditing("new")}
      >
        {rows.length === 0 ? (
          <EmptyGridRow cols={4} text={messages.settings.empty} />
        ) : (
          rows.map((row) => (
            <GridRow key={row.id} onClick={() => setEditing(row)}>
              <GridCell mono>{row.userid}</GridCell>
              <GridCell>{row.username}</GridCell>
              <GridCell>
                <span className="inline-flex items-center gap-1">
                  {row.roles.map((role) => (
                    <Chip key={role}>{roleLabel(messages, role)}</Chip>
                  ))}
                </span>
              </GridCell>
              <GridCell>
                <span className={row.active ? "text-success" : "text-text-tertiary"}>
                  {row.active ? messages.settings.active : messages.settings.inactive}
                </span>
              </GridCell>
            </GridRow>
          ))
        )}
      </SettingsList>
      <AppDialog
        open={editing !== null}
        title={editing === "new" ? messages.settings.newUser : messages.settings.editUser}
        onClose={() => setEditing(null)}
        footer={
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setEditing(null)}>
              {messages.common.cancel}
            </Button>
            <Button type="submit" form="user-form" variant="primary" disabled={saving}>
              {saving ? messages.common.saving : messages.common.save}
            </Button>
          </div>
        }
      >
        <form
          id="user-form"
          key={editing === "new" ? "new" : editing?.id}
          className="grid gap-3 p-4"
          onSubmit={(event) => void onSubmit(event)}
        >
          <FormField label={messages.settings.userid}>
            <input
              className="field-control"
              name="userid"
              required
              autoComplete="off"
              defaultValue={editing && editing !== "new" ? editing.userid : ""}
              disabled={editing !== "new"}
            />
          </FormField>
          <FormField label={messages.settings.username}>
            <input
              className="field-control"
              name="username"
              required
              defaultValue={editing && editing !== "new" ? editing.username : ""}
            />
          </FormField>
          <FormField
            label={messages.settings.password}
            hint={editing === "new" ? undefined : messages.settings.passwordHint}
          >
            <input
              className="field-control"
              name="password"
              type="password"
              autoComplete="new-password"
              required={editing === "new"}
            />
          </FormField>
          <FormField label={messages.settings.role}>
            <Select
              name="role"
              defaultValue={
                editing && editing !== "new" ? (editing.roles[0] ?? "analyst") : "analyst"
              }
              options={
                roles.length > 0
                  ? roles.map((role) => ({
                      value: role.code,
                      label: role.name,
                    }))
                  : [
                      { value: "admin", label: messages.settings.roleAdmin },
                      { value: "operator", label: messages.settings.roleOperator },
                      { value: "analyst", label: messages.settings.roleAnalyst },
                      { value: "viewer", label: messages.settings.roleViewer },
                    ]
              }
            />
          </FormField>
          {editing && editing !== "new" ? (
            <label className="flex items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                name="active"
                defaultChecked={editing.active}
              />
              {messages.settings.active}
            </label>
          ) : null}
        </form>
      </AppDialog>
    </>
  );
}

function CodesPage({ query, onQuery }: { query: string; onQuery: (value: string) => void }) {
  const { messages } = useLanguage();
  const rows = useMemo(
    () =>
      [
        { group: "USER_STATUS", code: "ACTIVE", name: messages.settings.mock.codeActive, order: 1, used: true },
        { group: "USER_STATUS", code: "INACTIVE", name: messages.settings.mock.codeInactive, order: 2, used: true },
        { group: "JOB_KIND", code: "EXTRACT", name: messages.settings.mock.codeExtract, order: 1, used: true },
        { group: "JOB_KIND", code: "TRANSFORM", name: messages.settings.mock.codeTransform, order: 2, used: true },
        { group: "JOB_KIND", code: "LOAD", name: messages.settings.mock.codeLoad, order: 3, used: false },
        { group: "LOCALE", code: "ko", name: messages.settings.mock.codeKo, order: 1, used: true },
        { group: "LOCALE", code: "en", name: messages.settings.mock.codeEn, order: 2, used: true },
      ].filter((row) => hasQuery(query, row.group, row.code, row.name)),
    [messages, query],
  );

  return (
    <SettingsList
      title={messages.settings.codes}
      description={messages.settings.codesDesc}
      count={rows.length}
      query={query}
      onQuery={onQuery}
      headers={messages.settings.codeHeaders}
    >
      {rows.length === 0 ? (
        <EmptyGridRow cols={5} text={messages.settings.empty} />
      ) : (
        rows.map((row) => (
          <GridRow key={`${row.group}.${row.code}`}>
            <GridCell mono muted>{row.group}</GridCell>
            <GridCell mono>{row.code}</GridCell>
            <GridCell>{row.name}</GridCell>
            <GridCell muted>{row.order}</GridCell>
            <GridCell>
              <span className={row.used ? "text-success" : "text-text-tertiary"}>
                {row.used ? messages.settings.used : messages.settings.unused}
              </span>
            </GridCell>
          </GridRow>
        ))
      )}
    </SettingsList>
  );
}

function MessagesPage({ query, onQuery }: { query: string; onQuery: (value: string) => void }) {
  const { messages } = useLanguage();
  const rows = useMemo(
    () =>
      [
        { code: "AUTH.LOGIN_FAILED", locale: "ko", text: "로그인에 실패했습니다." },
        { code: "AUTH.LOGIN_FAILED", locale: "en", text: "Sign-in failed." },
        { code: "COMMON.SAVED", locale: "ko", text: "저장되었습니다." },
        { code: "COMMON.SAVED", locale: "en", text: "Saved." },
        { code: "AUTH.DENIED", locale: "ko", text: "권한이 없습니다." },
        { code: "AUTH.DENIED", locale: "en", text: "Permission denied." },
        { code: "COMMON.NOT_FOUND", locale: "ko", text: "항목을 찾을 수 없습니다." },
        { code: "COMMON.NOT_FOUND", locale: "en", text: "Item not found." },
      ].filter((row) => hasQuery(query, row.code, row.locale, row.text)),
    [query],
  );

  return (
    <SettingsList
      title={messages.settings.messages}
      description={messages.settings.messagesDesc}
      count={rows.length}
      query={query}
      onQuery={onQuery}
      headers={messages.settings.messageHeaders}
    >
      {rows.length === 0 ? (
        <EmptyGridRow cols={3} text={messages.settings.empty} />
      ) : (
        rows.map((row) => (
          <GridRow key={`${row.code}.${row.locale}`}>
            <GridCell mono>{row.code}</GridCell>
            <GridCell mono muted>{row.locale}</GridCell>
            <GridCell>{row.text}</GridCell>
          </GridRow>
        ))
      )}
    </SettingsList>
  );
}

const PAGE_VIEW: Record<
  PageId,
  (props: { query: string; onQuery: (value: string) => void }) => ReactNode
> = {
  roles: (props) => <RolesPage {...props} />,
  permissions: (props) => <PermissionsPage {...props} />,
  users: (props) => <UsersPage {...props} />,
  codes: (props) => <CodesPage {...props} />,
  messages: (props) => <MessagesPage {...props} />,
};

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { messages } = useLanguage();
  const [page, setPage] = useState<PageId>("roles");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    setPage("roles");
    setQuery("");
  }, [open]);

  return (
    <AppDialog
      open={open}
      title={<span className="text-base">{messages.settings.title}</span>}
      icon={<Settings className="size-5 text-accent" aria-hidden="true" />}
      className="h-[min(52rem,92vh)] w-[min(88rem,96vw)]"
      minWidth={800}
      minHeight={480}
      onClose={onClose}
    >
      <SplitLayout
        className="min-h-0 flex-1"
        defaultSizes={[layout.split.settings]}
        minSize={layout.split.minSettings}
        maxSize={layout.split.maxSettings}
      >
        <aside className="flex h-full min-h-0 flex-col bg-raised p-3">
          <nav className="flex flex-col gap-2" aria-label={messages.settings.title}>
            {PAGES.map((item) => {
              const active = page === item.id;
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40",
                    active ? "bg-accent-subtle text-accent" : "text-text hover:bg-subtle",
                  )}
                  onClick={() => {
                    setPage(item.id);
                    setQuery("");
                  }}
                >
                  <Icon className="size-[18px] shrink-0" aria-hidden="true" />
                  <span className="truncate">{item.label(messages)}</span>
                </button>
              );
            })}
          </nav>
        </aside>
        <DialogContentTransition contentKey={page} resetWhen={open} className="flex min-h-0 min-w-0 flex-1 flex-col">
          {PAGE_VIEW[page]({ query, onQuery: setQuery })}
        </DialogContentTransition>
      </SplitLayout>
    </AppDialog>
  );
}
