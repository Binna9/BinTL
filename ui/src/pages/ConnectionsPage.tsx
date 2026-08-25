import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CircleCheck, Maximize2, Pencil, PlugZap, Save, SquarePen, Trash2, X } from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { CatalogTree } from "@/components/CatalogTree";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { PageHeader, PageShell } from "@/components/PageShell";
import { SplitLayout } from "@/components/SplitLayout";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { PaneHeader } from "@/components/ui/pane-header";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { useConnections } from "@/hooks/useConnections";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { layout } from "@/lib/layout";
import { toastError, toastSuccess } from "@/lib/notifications";
import { selectableClass } from "@/lib/selectable";
import { driverCatalog } from "@/mock/driverCatalog";
import { connectionApi } from "@/services/connectionApi";
import type { CatalogSelection, DataConnection, DatabaseColumn } from "@/types/connection";

function dash(value?: string | null): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "—";
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
  const navigate = useNavigate();
  const { connections, refreshConnections } = useConnections();
  const [saving, setSaving] = useState(false);
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
    const port = field("port").value;

    setSaving(true);
    try {
      await connectionApi.createConnection({
        name: field("name").value,
        driver: field("driver").value,
        host: field("host").value,
        port: port ? Number(port) : undefined,
        database: field("database").value,
        username: field("username").value,
        password: field("password").value,
        ssl: (field("ssl") as HTMLInputElement).checked,
      });
      form.reset();
      await refreshConnections();
      toastSuccess(messages.connectionsPage.saved);
    } catch (err) {
      toastError(messages.errors.saveConnection, err);
    } finally {
      setSaving(false);
    }
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
    const port = field("port").value;

    setEditSaving(true);
    try {
      await connectionApi.updateConnection(editing.id, {
        name: field("name").value,
        driver: field("driver").value,
        host: field("host").value,
        port: port ? Number(port) : undefined,
        database: field("database").value,
        username: field("username").value,
        password: field("password").value,
        ssl: (field("ssl") as HTMLInputElement).checked,
      });
      setEditing(null);
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

  async function onDelete(id: string) {
    try {
      await connectionApi.deleteConnection(id);
      if (browseId === id) {
        setBrowseId("");
        setSelected(null);
        setColumns([]);
        setColumnsExpanded(false);
      }
      await refreshConnections();
    } catch (err) {
      toastError(messages.errors.deleteConnection, err);
    }
  }

  const activeConnection = connections.find((connection) => connection.id === browseId);
  const example = (sample: string) =>
    `${messages.connectionsPage.examplePrefix} ${sample}`;

  return (
    <PageShell>
      <PageHeader
        iconName="connections"
        eyebrow={messages.connectionsPage.eyebrow}
        title={messages.connectionsPage.title}
        description={messages.connectionsPage.description}
      />

      <Panel className="shrink-0">
        <PanelHeader title={messages.connectionsPage.new} description={messages.connectionsPage.newDescription} />
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
                      options={driverCatalog.map((driver) => ({
                        value: driver.value,
                        label: driver.label,
                      }))}
                    />
                  </FormField>
                  <FormField
                    label={messages.connectionsPage.host}
                    example={example(messages.connectionsPage.hostPlaceholder)}
                  >
                    <input
                      className="field-control"
                      name="host"
                      required
                      autoComplete="off"
                      placeholder={messages.connectionsPage.hostPlaceholder}
                    />
                  </FormField>
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
                      required
                      autoComplete="off"
                      placeholder={messages.connectionsPage.databasePlaceholder}
                    />
                  </FormField>
                </div>
              </section>

              <section className="flex flex-col rounded-xl border border-border bg-subtle/50 p-4">
                <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
                  {messages.connectionsPage.sectionAuth}
                </h3>
                <div className="grid grid-cols-1 gap-3">
                  <FormField
                    label={messages.connectionsPage.username}
                    example={example(messages.connectionsPage.usernamePlaceholder)}
                  >
                    <input
                      className="field-control"
                      name="username"
                      required
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
            <div className="min-h-0 flex-1 overflow-y-auto bg-surface">
              {connections.length === 0 ? (
                <p className="p-4 text-xs text-text-tertiary">{messages.empty.connections}</p>
              ) : (
                <ul className="m-0 list-none p-0">
                  {connections.map((connection) => (
                    <li
                      key={connection.id}
                      className={cn(
                        "relative border-b border-border p-3 pr-16",
                        selectableClass(connection.id === browseId),
                      )}
                    >
                      <div className="absolute right-2 top-2 flex gap-0.5">
                        <button
                          type="button"
                          className="grid size-7 place-items-center rounded-md text-text-tertiary outline-none hover:bg-subtle hover:text-text focus-visible:ring-2 focus-visible:ring-accent/40"
                          aria-label={messages.common.edit}
                          title={messages.common.edit}
                          onClick={() => setEditing(connection)}
                        >
                          <Pencil className="size-3.5" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="grid size-7 place-items-center rounded-md text-text-tertiary outline-none hover:bg-danger-subtle hover:text-danger focus-visible:ring-2 focus-visible:ring-accent/40"
                          aria-label={messages.common.delete}
                          title={messages.common.delete}
                          onClick={() => void onDelete(connection.id)}
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </button>
                      </div>
                      <button
                        type="button"
                        title={connection.name}
                        className="block w-full min-w-0 overflow-hidden text-left"
                        onClick={() => void onBrowse(connection.id)}
                      >
                        <span className="block truncate text-[13px] text-text">{connection.name}</span>
                        <span className="mt-1 block truncate text-[11px] text-text-tertiary">
                          {connection.driver} · {connection.host}:{connection.port}
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
                </ul>
              )}
            </div>
          </aside>

          {!activeConnection ? (
            <div className="grid h-full place-items-center text-[13px] text-text-tertiary">
              {messages.connectionsPage.selectConnectionHint}
            </div>
          ) : (
            <SplitLayout className="h-full min-w-0" defaultSizes={[layout.split.catalog]}>
              <aside className="flex h-full min-h-0 flex-col overflow-hidden bg-surface">
                <PaneHeader title={messages.common.catalog} />
                <div className="min-h-0 flex-1 overflow-y-auto">
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
                      <>
                        <Button
                          type="button"
                          variant="secondary"
                          title={messages.connectionsPage.expand}
                          onClick={() => setColumnsExpanded(true)}
                        >
                          <Maximize2 className="size-3.5" aria-hidden="true" />
                          {messages.connectionsPage.expand}
                        </Button>
                        <Button
                          type="button"
                          variant="primary"
                          onClick={() =>
                            navigate(
                              `/db?connection=${browseId}&table=${encodeURIComponent(selected.qualified)}&database=${encodeURIComponent(selected.database)}`,
                            )
                          }
                        >
                          <SquarePen className="size-3.5" aria-hidden="true" />
                          {messages.connectionsPage.queryExtract}
                        </Button>
                      </>
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
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
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
            className="grid min-h-0 flex-1 grid-cols-2 content-start gap-3 overflow-auto p-4"
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
            <FormField label={messages.connectionsPage.host}>
              <input className="field-control" name="host" defaultValue={editing.host} required />
            </FormField>
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
            <FormField label={messages.connectionsPage.username}>
              <input className="field-control" name="username" defaultValue={editing.username} required />
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
          </form>
        ) : null}
      </AppDialog>
    </PageShell>
  );
}
