import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { SplitLayout } from "@/components/SplitLayout";
import { Button } from "@/components/ui/button";
import { PaneHeader } from "@/components/ui/pane-header";
import { Toolbar } from "@/components/ui/toolbar";
import { useLanguage } from "@/i18n/LanguageProvider";
import type { Messages } from "@/i18n/ko";
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
}: {
  title: string;
  description: string;
  count: number;
  query: string;
  onQuery: (value: string) => void;
  headers: readonly string[];
  children: ReactNode;
}) {
  const { messages } = useLanguage();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PaneHeader
        title={title}
        description={description}
        meta={messages.common.count(count)}
        actions={
          <Button type="button" variant="primary">
            <Plus className="size-3.5" aria-hidden="true" />
            {messages.settings.add}
          </Button>
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
  const rows = useMemo(
    () =>
      [
        {
          name: "ADMIN",
          description: messages.settings.mock.roleAdmin,
          permissions: ["USER_READ", "USER_WRITE", "ROLE_MANAGE", "PERM_MANAGE"],
        },
        {
          name: "OPERATOR",
          description: messages.settings.mock.roleOperator,
          permissions: ["EXTRACT_RUN", "TRANSFORM_RUN", "JOB_CANCEL"],
        },
        {
          name: "ANALYST",
          description: messages.settings.mock.roleAnalyst,
          permissions: ["DATASET_READ", "TRANSFORM_RUN"],
        },
        {
          name: "VIEWER",
          description: messages.settings.mock.roleViewer,
          permissions: ["DATASET_READ"],
        },
      ].filter((row) => hasQuery(query, row.name, row.description, ...row.permissions)),
    [messages, query],
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
          <GridRow key={row.name}>
            <GridCell mono>{row.name}</GridCell>
            <GridCell>{row.description}</GridCell>
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
  const rows = useMemo(
    () =>
      [
        { name: "USER_READ", description: messages.settings.mock.permUserRead },
        { name: "USER_WRITE", description: messages.settings.mock.permUserWrite },
        { name: "ROLE_MANAGE", description: messages.settings.mock.permRoleManage },
        { name: "PERM_MANAGE", description: messages.settings.mock.permPermManage },
        { name: "EXTRACT_RUN", description: messages.settings.mock.permExtractRun },
        { name: "TRANSFORM_RUN", description: messages.settings.mock.permTransformRun },
        { name: "DATASET_READ", description: messages.settings.mock.permDatasetRead },
        { name: "JOB_CANCEL", description: messages.settings.mock.permJobCancel },
      ].filter((row) => hasQuery(query, row.name, row.description)),
    [messages, query],
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
          <GridRow key={row.name}>
            <GridCell mono>{row.name}</GridCell>
            <GridCell>{row.description}</GridCell>
          </GridRow>
        ))
      )}
    </SettingsList>
  );
}

function UsersPage({ query, onQuery }: { query: string; onQuery: (value: string) => void }) {
  const { messages } = useLanguage();
  const rows = useMemo(
    () =>
      [
        {
          name: messages.settings.mock.userAdmin,
          email: "hangyeol@bintl.local",
          roles: ["ADMIN"],
        },
        {
          name: messages.settings.mock.userOps,
          email: "seoyeon@bintl.local",
          roles: ["OPERATOR"],
        },
        {
          name: messages.settings.mock.userAnalyst,
          email: "junho@bintl.local",
          roles: ["ANALYST", "VIEWER"],
        },
        {
          name: messages.settings.mock.userViewer,
          email: "minji@bintl.local",
          roles: ["VIEWER"],
        },
      ].filter((row) => hasQuery(query, row.name, row.email, ...row.roles)),
    [messages, query],
  );

  return (
    <SettingsList
      title={messages.settings.users}
      description={messages.settings.usersDesc}
      count={rows.length}
      query={query}
      onQuery={onQuery}
      headers={messages.settings.userHeaders}
    >
      {rows.length === 0 ? (
        <EmptyGridRow cols={3} text={messages.settings.empty} />
      ) : (
        rows.map((row) => (
          <GridRow key={row.email}>
            <GridCell>{row.name}</GridCell>
            <GridCell muted>{row.email}</GridCell>
            <GridCell>
              <span className="inline-flex items-center gap-1">
                {row.roles.map((role) => (
                  <Chip key={role}>{role}</Chip>
                ))}
              </span>
            </GridCell>
          </GridRow>
        ))
      )}
    </SettingsList>
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
        {PAGE_VIEW[page]({ query, onQuery: setQuery })}
      </SplitLayout>
    </AppDialog>
  );
}
