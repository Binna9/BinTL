import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CircleCheck, Pencil, PlugZap, Save, SquarePen, Trash2, X } from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { CatalogTree } from "@/components/CatalogTree";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { PageHeader, PageShell } from "@/components/PageShell";
import { SplitLayout } from "@/components/SplitLayout";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Select } from "@/components/ui/select";
import { NoticeBanner } from "@/components/ui/notice-banner";
import { PaneHeader } from "@/components/ui/pane-header";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { useConnections } from "@/hooks/useConnections";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { layout } from "@/lib/layout";
import { selectableClass } from "@/lib/selectable";
import { driverCatalog } from "@/mock/driverCatalog";
import { connectionApi } from "@/services/connectionApi";
import type { CatalogSelection, DataConnection, DatabaseColumn } from "@/types/connection";

function dash(value?: string | null): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "—";
}

export function ConnectionsPage() {
  const { messages } = useLanguage();
  const navigate = useNavigate();
  const {
    connections,
    connectionsError,
    setConnectionsError,
    refreshConnections,
  } = useConnections();
  const [info, setInfo] = useState("");
  const [saving, setSaving] = useState(false);
  const [browseId, setBrowseId] = useState("");
  const [selected, setSelected] = useState<CatalogSelection | null>(null);
  const [columns, setColumns] = useState<DatabaseColumn[]>([]);
  const [editing, setEditing] = useState<DataConnection | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [testingId, setTestingId] = useState("");
  const [testStatus, setTestStatus] = useState<Record<string, "ok" | "fail">>({});

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const field = (name: string) =>
      form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
    const port = field("port").value;

    setSaving(true);
    setConnectionsError("");
    setInfo("");
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
      setInfo(messages.connectionsPage.saved);
    } catch (err) {
      setConnectionsError(err instanceof Error ? err.message : messages.errors.saveConnection);
    } finally {
      setSaving(false);
    }
  }

  async function onTest(id: string) {
    setTestingId(id);
    try {
      await connectionApi.testConnection(id);
      setTestStatus((current) => ({ ...current, [id]: "ok" }));
    } catch {
      setTestStatus((current) => ({ ...current, [id]: "fail" }));
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
    setEditError("");
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
      setEditError(err instanceof Error ? err.message : messages.errors.saveConnection);
    } finally {
      setEditSaving(false);
    }
  }

  async function onBrowse(id: string) {
    if (browseId === id) {
      setBrowseId("");
      setSelected(null);
      setColumns([]);
      return;
    }
    setBrowseId(id);
    setSelected(null);
    setColumns([]);
    setConnectionsError("");
  }

  async function onSelectTable(pick: CatalogSelection | null) {
    if (!pick) {
      setSelected(null);
      setColumns([]);
      return;
    }
    if (!browseId) return;
    setSelected(pick);
    setConnectionsError("");
    try {
      const columnResult = await connectionApi.getColumns(
        browseId,
        pick.qualified,
        pick.database,
      );
      setColumns(columnResult.columns);
    } catch (err) {
      setColumns([]);
      setConnectionsError(
        err instanceof Error ? err.message : messages.errors.tableInfo,
      );
    }
  }

  async function onDelete(id: string) {
    setConnectionsError("");
    try {
      await connectionApi.deleteConnection(id);
      if (browseId === id) {
        setBrowseId("");
        setSelected(null);
        setColumns([]);
      }
      await refreshConnections();
    } catch (err) {
      setConnectionsError(err instanceof Error ? err.message : messages.errors.deleteConnection);
    }
  }

  const activeConnection = connections.find((connection) => connection.id === browseId);

  return (
    <PageShell>
      <PageHeader
        iconName="connections"
        eyebrow={messages.connectionsPage.eyebrow}
        title={messages.connectionsPage.title}
        description={messages.connectionsPage.description}
      />
      {info ? <NoticeBanner tone="ok">{info}</NoticeBanner> : null}
      {connectionsError ? <NoticeBanner>{connectionsError}</NoticeBanner> : null}

      <Panel className="shrink-0">
        <PanelHeader title={messages.connectionsPage.new} description={messages.connectionsPage.newDescription} />
        <PanelBody className="py-3">
          <form className="grid grid-cols-4 items-end gap-3" onSubmit={(event) => void onSave(event)}>
            <FormField label={messages.connectionsPage.name}>
              <input className="field-control" name="name" required />
            </FormField>
            <FormField label={messages.connectionsPage.driver}>
              <Select
                name="driver"
                options={driverCatalog.map((driver) => ({
                  value: driver.value,
                  label: driver.label,
                }))}
              />
            </FormField>
            <FormField label={messages.connectionsPage.host}>
              <input className="field-control" name="host" defaultValue="127.0.0.1" required />
            </FormField>
            <FormField label={messages.connectionsPage.port}>
              <input className="field-control technical" name="port" placeholder="5432" />
            </FormField>
            <FormField label={messages.connectionsPage.database}>
              <input className="field-control" name="database" required placeholder="dbname / /path/to.db" />
            </FormField>
            <FormField label={messages.connectionsPage.username}>
              <input className="field-control" name="username" required />
            </FormField>
            <FormField label={messages.connectionsPage.password}>
              <input className="field-control" name="password" type="password" />
            </FormField>
            <div className="flex h-8 items-center justify-between gap-3">
              <label className="flex min-w-0 items-center gap-2 text-xs text-text-secondary">
                <input className="field-control" name="ssl" type="checkbox" />
                {messages.connectionsPage.useSsl}
                <span className="truncate text-[11px] font-normal text-text-tertiary">
                  {messages.connectionsPage.sslHint}
                </span>
              </label>
              <Button variant="primary" type="submit" disabled={saving}>
                <Save className="size-3.5" aria-hidden="true" />
                {saving ? messages.common.saving : messages.common.save}
              </Button>
            </div>
          </form>
        </PanelBody>
      </Panel>

      <Panel>
        <Toolbar>
          <ToolbarGroup>
            <span className="text-[13px] font-semibold">{messages.connectionsPage.explorer}</span>
            <span className="text-xs text-text-tertiary">
              {activeConnection ? activeConnection.name : messages.connectionsPage.selectConnection}
            </span>
          </ToolbarGroup>
        </Toolbar>

        <SplitLayout fill={false} className="min-h-[36rem]" defaultSizes={[layout.split.sidebar]}>
          <aside className="flex min-h-[36rem] flex-col">
            <PaneHeader title={messages.common.connections} meta={messages.common.count(connections.length)} />
            <div className="bg-surface">
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
                          onClick={() => {
                            setEditError("");
                            setEditing(connection);
                          }}
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
            <div className="grid min-h-[36rem] place-items-center text-[13px] text-text-tertiary">
              {messages.connectionsPage.selectConnectionHint}
            </div>
          ) : (
            <SplitLayout fill={false} className="min-h-[36rem] min-w-0" defaultSizes={[layout.split.catalog]}>
              <aside className="flex min-h-[36rem] flex-col bg-surface">
                <PaneHeader title={messages.common.catalog} />
                <div>
                  <CatalogTree
                    connectionId={activeConnection.id}
                    selected={selected}
                    onPick={(pick) => void onSelectTable(pick)}
                  />
                </div>
              </aside>

              {!selected ? (
                <div className="grid min-h-[36rem] place-items-center text-[13px] text-text-tertiary">
                  {messages.connectionsPage.selectTableHint}
                </div>
              ) : (
                <div className="flex min-w-0 flex-col">
                  <Toolbar>
                    <ToolbarGroup>
                      <span className="technical font-semibold text-text">{selected.qualified}</span>
                    </ToolbarGroup>
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
                  </Toolbar>
                  <section className="flex flex-col">
                    <PaneHeader title={messages.common.columns} meta={`${columns.length}`} />
                    <div className="bg-surface">
                      <DataGrid headers={[...messages.connectionsPage.columnHeaders]}>
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
                              <GridCell muted>{dash(column.extra)}</GridCell>
                            </GridRow>
                          ))
                        )}
                      </DataGrid>
                    </div>
                  </section>
                </div>
              )}
            </SplitLayout>
          )}
        </SplitLayout>
      </Panel>

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
            {editError ? <div className="col-span-2"><NoticeBanner>{editError}</NoticeBanner></div> : null}
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
