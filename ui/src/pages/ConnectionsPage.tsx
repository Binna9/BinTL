import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CatalogTree } from "@/components/CatalogTree";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { PageHeader, PageShell } from "@/components/PageShell";
import { SplitLayout } from "@/components/SplitLayout";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
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
import { extractApi } from "@/services/extractApi";
import type {
  CatalogSelection,
  DatabaseColumn,
  TablePreview,
} from "@/types/connection";

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
  const [preview, setPreview] = useState<TablePreview | null>(null);
  const [delimiter, setDelimiter] = useState(",");
  const [header, setHeader] = useState(true);
  const [extracting, setExtracting] = useState(false);

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
    setConnectionsError("");
    setInfo("");
    try {
      await connectionApi.testConnection(id);
      setInfo(messages.connectionsPage.testSucceeded);
    } catch (err) {
      setConnectionsError(err instanceof Error ? err.message : messages.errors.testConnection);
    }
  }

  async function onBrowse(id: string) {
    if (browseId === id) {
      setBrowseId("");
      setSelected(null);
      setColumns([]);
      setPreview(null);
      return;
    }
    setBrowseId(id);
    setSelected(null);
    setColumns([]);
    setPreview(null);
    setConnectionsError("");
  }

  async function onSelectTable(pick: CatalogSelection | null) {
    if (!pick) {
      setSelected(null);
      setColumns([]);
      setPreview(null);
      return;
    }
    if (!browseId) return;
    setSelected(pick);
    setConnectionsError("");
    try {
      const [columnResult, previewResult] = await Promise.all([
        connectionApi.getColumns(browseId, pick.qualified, pick.database),
        connectionApi.getPreview(browseId, pick.qualified, 50, pick.database),
      ]);
      setColumns(columnResult.columns);
      setPreview(previewResult);
    } catch (err) {
      setColumns([]);
      setPreview(null);
      setConnectionsError(
        err instanceof Error ? err.message : messages.errors.tableInfo,
      );
    }
  }

  async function onExtract(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!browseId || !selected) return;
    setExtracting(true);
    setConnectionsError("");
    try {
      await extractApi.createExtract({
        connection_id: browseId,
        table: selected.qualified,
        database: selected.database,
        delimiter,
        header,
      });
      navigate("/extracts");
    } catch (err) {
      setConnectionsError(err instanceof Error ? err.message : messages.errors.extract);
    } finally {
      setExtracting(false);
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
        setPreview(null);
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

      <Panel>
        <PanelHeader title={messages.connectionsPage.new} description={messages.connectionsPage.newDescription} />
        <PanelBody>
          <form className="grid grid-cols-4 items-end gap-3" onSubmit={(event) => void onSave(event)}>
            <FormField label={messages.connectionsPage.name}>
              <input className="field-control" name="name" required />
            </FormField>
            <FormField label={messages.connectionsPage.driver}>
              <select className="field-control" name="driver">
                {driverCatalog.map((driver) => (
                  <option key={driver.value} value={driver.value}>{driver.label}</option>
                ))}
              </select>
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
                {saving ? messages.common.saving : messages.common.save}
              </Button>
            </div>
          </form>
        </PanelBody>
      </Panel>

      <Panel className="min-h-[34rem]">
        <Toolbar>
          <ToolbarGroup>
            <span className="text-[13px] font-semibold">{messages.connectionsPage.explorer}</span>
            <span className="text-xs text-text-tertiary">
              {activeConnection ? activeConnection.name : messages.connectionsPage.selectConnection}
            </span>
          </ToolbarGroup>
        </Toolbar>

        <SplitLayout className="min-h-[31rem]" defaultSizes={[layout.split.sidebar]}>
          <aside className="flex h-full min-h-0 flex-col">
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
                        "border-b border-border p-3",
                        selectableClass(connection.id === browseId),
                      )}
                    >
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
                      <div className="mt-2 flex gap-1">
                        <Button type="button" variant="quiet" onClick={() => void onTest(connection.id)}>
                          {messages.common.test}
                        </Button>
                        <Button
                          type="button"
                          variant="quiet"
                          onClick={() => navigate(`/db?connection=${connection.id}`)}
                        >
                          {messages.connectionsPage.query}
                        </Button>
                        <Button type="button" variant="danger" onClick={() => void onDelete(connection.id)}>
                          {messages.common.delete}
                        </Button>
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
              <aside className="flex h-full min-h-0 flex-col bg-surface">
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
                <div className="flex h-full min-w-0 flex-col">
                  <Toolbar>
                    <ToolbarGroup>
                      <span className="technical font-semibold text-text">{selected.qualified}</span>
                    </ToolbarGroup>
                    <form className="flex items-center gap-2" onSubmit={(event) => void onExtract(event)}>
                      <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                        {messages.common.delimiter}
                        <input
                          className="field-control technical w-16 text-center"
                          value={delimiter}
                          onChange={(event) => setDelimiter(event.target.value)}
                          placeholder=","
                          title={messages.connectionsPage.delimiterTitle}
                          aria-label={messages.common.delimiter}
                          required
                        />
                      </label>
                      <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                        <input
                          className="field-control"
                          type="checkbox"
                          checked={header}
                          onChange={(event) => setHeader(event.target.checked)}
                        />
                        {messages.common.header}
                      </label>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() =>
                          navigate(
                            `/db?connection=${browseId}&table=${encodeURIComponent(selected.qualified)}&database=${encodeURIComponent(selected.database)}`,
                          )
                        }
                      >
                        {messages.connectionsPage.dbEdit}
                      </Button>
                      <Button variant="primary" type="submit" disabled={extracting}>
                        {extracting ? messages.connectionsPage.extracting : messages.connectionsPage.extractFile}
                      </Button>
                    </form>
                  </Toolbar>

                  <SplitLayout className="min-h-0 flex-1" defaultSizes={[layout.split.columns]}>
                    <section className="flex h-full min-h-0 flex-col overflow-hidden">
                      <PaneHeader title={messages.common.columns} meta={`${columns.length}`} />
                      <div className="min-h-0 flex-1 overflow-auto bg-surface">
                        <DataGrid headers={[...messages.connectionsPage.columnHeaders]}>
                          {columns.map((column) => (
                            <GridRow key={column.name}>
                              <GridCell mono>{column.name}</GridCell>
                              <GridCell mono muted>{column.data_type}</GridCell>
                              <GridCell muted>{column.nullable ? messages.common.yes : messages.common.no}</GridCell>
                            </GridRow>
                          ))}
                        </DataGrid>
                      </div>
                    </section>
                    <section className="flex h-full min-h-0 flex-col overflow-hidden">
                      <PaneHeader title={messages.connectionsPage.preview} />
                      <div className="min-h-0 flex-1 overflow-auto bg-surface">
                        {preview ? (
                          <DataGrid className="h-full" headers={preview.columns}>
                            {preview.rows.length === 0 ? (
                              <EmptyGridRow cols={preview.columns.length || 1} text={messages.empty.preview} />
                            ) : (
                              preview.rows.map((row, rowIndex) => (
                                <GridRow key={rowIndex}>
                                  {row.map((cell, cellIndex) => (
                                    <GridCell key={cellIndex} mono>{cell}</GridCell>
                                  ))}
                                </GridRow>
                              ))
                            )}
                          </DataGrid>
                        ) : null}
                      </div>
                    </section>
                  </SplitLayout>
                </div>
              )}
            </SplitLayout>
          )}
        </SplitLayout>
      </Panel>
    </PageShell>
  );
}
