import { useEffect, useMemo, useState } from "react";
import { BookmarkPlus, FileDown, Play, Plus, Trash2 } from "lucide-react";
import {
  columnWidthsForContent,
  DataGrid,
  EmptyGridRow,
  GridCell,
  GridRow,
} from "@/components/DataGrid";
import { AppDialog } from "@/components/AppDialog";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { SplitLayout } from "@/layouts/SplitLayout";
import { Button, ActionAnchor } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { PaneHeader } from "@/components/ui/pane-header";
import { Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { useConnections } from "@/hooks/connections/useConnections";
import { isExtractActive } from "@/hooks/extract/useExtracts";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { DELIMITER_VALUES } from "@/lib/delimiter";
import { layout } from "@/lib/layout";
import { toastError, toastSuccess } from "@/lib/notifications";
import { selectableClass } from "@/lib/selectable";
import { extractApi } from "@/services/extract/extractApi";
import { chipApi } from "@/services/chips/chipApi";
import { connectionApi } from "@/services/connections/connectionApi";
import type { ExtractRecord, HttpKv, HttpPreviewResponse, HttpSource } from "@/types/extract";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const PREVIEW_LIMITS = [10, 20, 50, 100] as const;

function emptyKv(): HttpKv {
  return { name: "", value: "" };
}

function compactKv(rows: HttpKv[]): HttpKv[] {
  return rows.filter((row) => row.name.trim());
}

function KvEditor({
  rows,
  onChange,
  nameLabel,
  valueLabel,
  addLabel,
}: {
  rows: HttpKv[];
  onChange: (next: HttpKv[]) => void;
  nameLabel: string;
  valueLabel: string;
  addLabel: string;
}) {
  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] gap-2">
          <input
            className="field-control technical"
            value={row.name}
            placeholder={nameLabel}
            onChange={(event) => {
              const next = rows.slice();
              next[index] = { ...row, name: event.target.value };
              onChange(next);
            }}
          />
          <input
            className="field-control technical"
            value={row.value}
            placeholder={valueLabel}
            onChange={(event) => {
              const next = rows.slice();
              next[index] = { ...row, value: event.target.value };
              onChange(next);
            }}
          />
          <button
            type="button"
            className="inline-flex size-9 items-center justify-center rounded-lg text-text-tertiary hover:bg-subtle hover:text-text"
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
            aria-label="remove"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
      <Button type="button" variant="secondary" className="gap-1.5" onClick={() => onChange([...rows, emptyKv()])}>
        <Plus className="size-3.5" />
        {addLabel}
      </Button>
    </div>
  );
}

export function ApiExtractPage() {
  const { messages } = useLanguage();
  const { connections, refreshConnections } = useConnections();
  const httpConnections = useMemo(
    () => connections.filter((connection) => connection.driver === "http"),
    [connections],
  );

  const [browseId, setBrowseId] = useState("");
  const [method, setMethod] = useState<string>("GET");
  const [path, setPath] = useState("/v1/items");
  const [query, setQuery] = useState<HttpKv[]>([emptyKv()]);
  const [headers, setHeaders] = useState<HttpKv[]>([emptyKv()]);
  const [body, setBody] = useState("");
  const [recordsPath, setRecordsPath] = useState("");
  const [limit, setLimit] = useState<(typeof PREVIEW_LIMITS)[number]>(50);
  const [delimiter, setDelimiter] = useState(",");
  const [header, setHeader] = useState(true);
  const [addSequence, setAddSequence] = useState(false);
  const [exportName, setExportName] = useState("");
  const [preview, setPreview] = useState<HttpPreviewResponse | null>(null);
  const [info, setInfo] = useState("");
  const [running, setRunning] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractId, setExtractId] = useState<string | null>(null);
  const [extractRow, setExtractRow] = useState<ExtractRecord | null>(null);
  const [isRegisterOpen, setIsRegisterOpen] = useState(false);
  const [registerName, setRegisterName] = useState("");
  const [registerBusy, setRegisterBusy] = useState(false);
  const [newConnOpen, setNewConnOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newBaseUrl, setNewBaseUrl] = useState("https://");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newSaving, setNewSaving] = useState(false);

  useEffect(() => {
    if (!browseId && httpConnections[0]) setBrowseId(httpConnections[0].id);
  }, [browseId, httpConnections]);

  useEffect(() => {
    if (!extractId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await extractApi.getExtract(extractId);
        if (cancelled) return;
        setExtractRow(next);
        if (!isExtractActive(next.status)) return;
        window.setTimeout(() => {
          void tick();
        }, 800);
      } catch {
        /* ignore transient poll errors */
      }
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [extractId]);

  function buildSource(): HttpSource {
    return {
      type: "http",
      method,
      path: path.trim(),
      query: compactKv(query),
      headers: compactKv(headers),
      body: method === "GET" || method === "DELETE" ? null : body,
      records_path: recordsPath.trim(),
    };
  }

  async function runPreview() {
    if (!browseId) return;
    setRunning(true);
    setInfo("");
    try {
      const source = buildSource();
      const next = await extractApi.previewHttp({
        connection_id: browseId,
        method: source.method,
        path: source.path,
        query: source.query,
        headers: source.headers,
        body: source.body,
        records_path: source.records_path,
        limit,
      });
      setPreview(next);
      setInfo(
        messages.apiExtract.result(
          next.row_count,
          next.truncated,
          next.status,
        ),
      );
    } catch (err) {
      setPreview(null);
      toastError(messages.errors.query, err);
    } finally {
      setRunning(false);
    }
  }

  async function onExtract() {
    if (!browseId) return;
    setExtracting(true);
    try {
      const source = buildSource();
      const created = await extractApi.createExtract({
        kind: "api",
        connection_id: browseId,
        source,
        delimiter,
        header,
        add_sequence: addSequence,
        ...(exportName.trim() ? { filename: exportName.trim() } : {}),
      });
      setExtractId(created.id);
      setExtractRow(created);
      toastSuccess(messages.query.extractQueued);
    } catch (err) {
      toastError(messages.errors.extract, err);
    } finally {
      setExtracting(false);
    }
  }

  async function onRegister() {
    if (!browseId || !registerName.trim()) return;
    setRegisterBusy(true);
    try {
      await chipApi.register({
        name: registerName.trim(),
        kind: "extract",
        extract: {
          connection_id: browseId,
          source: buildSource(),
          delimiter,
          header,
        },
      });
      setIsRegisterOpen(false);
      toastSuccess(messages.query.taskRegisteredNamed(registerName.trim()));
    } catch (err) {
      toastError(messages.workspace.saveChipError, err);
    } finally {
      setRegisterBusy(false);
    }
  }

  async function onCreateConnection() {
    if (!newName.trim() || !newBaseUrl.trim()) return;
    setNewSaving(true);
    try {
      const created = await connectionApi.createConnection({
        name: newName.trim(),
        driver: "http",
        host: newBaseUrl.trim(),
        database: "",
        username: newUsername.trim(),
        password: newPassword,
        ssl: newBaseUrl.trim().startsWith("https"),
      });
      await refreshConnections();
      setBrowseId(created.id);
      setNewConnOpen(false);
      setNewName("");
      setNewBaseUrl("https://");
      setNewUsername("");
      setNewPassword("");
      toastSuccess(messages.connectionsPage.saved);
    } catch (err) {
      toastError(messages.errors.saveConnection, err);
    } finally {
      setNewSaving(false);
    }
  }

  const extractBusy = extracting || (extractRow ? isExtractActive(extractRow.status) : false);
  const canRun = Boolean(browseId && path.trim());
  const canExtract = canRun && Boolean(preview) && !extractBusy;
  const delimiterOptions = DELIMITER_VALUES.map((value) => ({ value, label: value === "tab" ? "tab" : value }));
  const resultWidths = useMemo(() => {
    if (!preview?.columns.length) return undefined;
    return columnWidthsForContent(preview.columns, preview.rows);
  }, [preview]);

  return (
    <PageShell>
      <PageHeader
        iconName="query"
        eyebrow={messages.apiExtract.eyebrow}
        title={messages.apiExtract.title}
        description={messages.apiExtract.description}
      />

      <Panel tall className="overflow-hidden">
        <SplitLayout className="min-h-0 flex-1" defaultSizes={[layout.split.sidebar]}>
          <aside className="flex h-full min-h-0 flex-col overflow-hidden border-r border-border">
            <PaneHeader
              title={messages.apiExtract.connections}
              meta={messages.common.count(httpConnections.length)}
              actions={
                <Button type="button" variant="secondary" className="gap-1.5" onClick={() => setNewConnOpen(true)}>
                  <Plus className="size-3.5" />
                  {messages.apiExtract.newConnection}
                </Button>
              }
            />
            <div className="scroll-pane min-h-0 flex-1 overflow-y-auto bg-surface">
              {httpConnections.length === 0 ? (
                <p className="p-3 text-xs text-text-tertiary">{messages.apiExtract.noConnections}</p>
              ) : (
                httpConnections.map((connection) => (
                  <button
                    key={connection.id}
                    type="button"
                    className={cn(
                      "block w-full min-w-0 overflow-hidden border-b border-border px-3 py-2 text-left last:border-b-0",
                      selectableClass(connection.id === browseId),
                    )}
                    onClick={() => setBrowseId(connection.id)}
                  >
                    <span className="block truncate text-[13px] text-text">{connection.name}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-text-tertiary">
                      {connection.host}
                    </span>
                  </button>
                ))
              )}
            </div>
          </aside>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="scroll-pane min-h-0 flex-1 overflow-y-auto p-4">
              <div className="mx-auto flex max-w-5xl flex-col gap-4">
                <section className="rounded-xl border border-border bg-subtle/40 p-4">
                  <div className="grid gap-3 md:grid-cols-[7rem_minmax(0,1fr)]">
                    <FormField label={messages.apiExtract.method}>
                      <Select
                        value={method}
                        options={METHODS.map((value) => ({ value, label: value }))}
                        onChange={setMethod}
                      />
                    </FormField>
                    <FormField label={messages.apiExtract.path}>
                      <input
                        className="field-control technical"
                        value={path}
                        placeholder="/v1/items"
                        onChange={(event) => setPath(event.target.value)}
                      />
                    </FormField>
                  </div>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <FormField label={messages.apiExtract.recordsPath} example={messages.apiExtract.recordsPathHint}>
                      <input
                        className="field-control technical"
                        value={recordsPath}
                        placeholder="data.items"
                        onChange={(event) => setRecordsPath(event.target.value)}
                      />
                    </FormField>
                    <FormField label={messages.query.exportFileName}>
                      <input
                        className="field-control technical"
                        value={exportName}
                        placeholder={messages.query.exportFileNamePlaceholder}
                        onChange={(event) => setExportName(event.target.value)}
                      />
                    </FormField>
                  </div>
                </section>

                <section className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-xl border border-border bg-subtle/40 p-4">
                    <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
                      {messages.apiExtract.queryParams}
                    </h3>
                    <KvEditor
                      rows={query}
                      onChange={setQuery}
                      nameLabel={messages.apiExtract.paramName}
                      valueLabel={messages.apiExtract.paramValue}
                      addLabel={messages.apiExtract.addParam}
                    />
                  </div>
                  <div className="rounded-xl border border-border bg-subtle/40 p-4">
                    <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
                      {messages.apiExtract.headers}
                    </h3>
                    <KvEditor
                      rows={headers}
                      onChange={setHeaders}
                      nameLabel={messages.apiExtract.headerName}
                      valueLabel={messages.apiExtract.headerValue}
                      addLabel={messages.apiExtract.addHeader}
                    />
                  </div>
                </section>

                {method === "GET" || method === "DELETE" ? null : (
                  <section className="rounded-xl border border-border bg-subtle/40 p-4">
                    <FormField label={messages.apiExtract.body}>
                      <textarea
                        className="field-control technical min-h-[8rem] font-mono text-[12px]"
                        value={body}
                        placeholder='{"page":1}'
                        onChange={(event) => setBody(event.target.value)}
                      />
                    </FormField>
                  </section>
                )}

                <section className="rounded-xl border border-border bg-surface overflow-hidden">
                  <PaneHeader
                    title={messages.apiExtract.previewTitle}
                    meta={info || undefined}
                    actions={
                      <div className="flex flex-wrap items-center gap-2">
                        <Select
                          className="!w-[4.75rem] technical"
                          value={String(limit)}
                          options={PREVIEW_LIMITS.map((value) => ({
                            value: String(value),
                            label: String(value),
                          }))}
                          onChange={(next) => setLimit(Number(next) as (typeof PREVIEW_LIMITS)[number])}
                        />
                        <Select
                          editable
                          className="!w-[6.5rem] technical"
                          value={delimiter}
                          options={delimiterOptions}
                          onChange={setDelimiter}
                        />
                        <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                          <input
                            className="field-control"
                            type="checkbox"
                            checked={header}
                            onChange={(event) => setHeader(event.target.checked)}
                          />
                          {messages.common.header}
                        </label>
                        <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                          <input
                            className="field-control"
                            type="checkbox"
                            checked={addSequence}
                            onChange={(event) => setAddSequence(event.target.checked)}
                          />
                          {messages.common.addSequence}
                        </label>
                        <Button
                          type="button"
                          className="gap-1.5"
                          disabled={!canRun || running}
                          onClick={() => void runPreview()}
                        >
                          <Play className="size-3.5" />
                          {running ? messages.apiExtract.calling : messages.apiExtract.call}
                        </Button>
                      </div>
                    }
                  />
                  <div className="h-[min(28rem,50vh)] min-h-[16rem]">
                    {!preview ? (
                      <p className="px-4 py-12 text-center text-[13px] text-text-tertiary">
                        {messages.apiExtract.previewHint}
                      </p>
                    ) : (
                      <DataGrid
                        className="h-full min-h-0"
                        headers={preview.columns}
                        columnWidths={resultWidths}
                      >
                        {preview.rows.length === 0 ? (
                          <EmptyGridRow cols={preview.columns.length} text={messages.apiExtract.emptyRows} />
                        ) : (
                          preview.rows.map((row, rowIndex) => (
                            <GridRow key={rowIndex}>
                              {row.map((cell, cellIndex) => (
                                <GridCell key={cellIndex} mono>
                                  {cell}
                                </GridCell>
                              ))}
                            </GridRow>
                          ))
                        )}
                      </DataGrid>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">
                    {extractRow?.status === "succeeded" ? (
                      <ActionAnchor variant="secondary" href={extractApi.getDownloadUrl(extractRow.id)}>
                        {messages.common.download}
                      </ActionAnchor>
                    ) : null}
                    {extractRow?.status === "failed" && extractRow.error_message ? (
                      <span className="mr-auto text-xs text-danger">{extractRow.error_message}</span>
                    ) : null}
                    {extractBusy ? (
                      <span className="mr-auto text-xs text-text-secondary">
                        {extractRow?.status === "running" && extractRow.row_count != null
                          ? messages.extracts.writing(extractRow.row_count)
                          : messages.query.extractQueued}
                      </span>
                    ) : null}
                    <Button
                      type="button"
                      variant="primary"
                      className="gap-1.5"
                      disabled={!canExtract}
                      onClick={() => void onExtract()}
                    >
                      <FileDown className="size-3.5" />
                      {extractBusy ? messages.connectionsPage.extracting : messages.query.resultFile}
                    </Button>
                    <Button
                      type="button"
                      className="gap-1.5"
                      disabled={!canRun}
                      onClick={() => {
                        setRegisterName(path.trim().replace(/^\//, "").replace(/\//g, "_") || messages.workspace.untitledExtract(1));
                        setIsRegisterOpen(true);
                      }}
                    >
                      <BookmarkPlus className="size-3.5" />
                      {messages.query.registerTask}
                    </Button>
                  </div>
                </section>
              </div>
            </div>
          </div>
        </SplitLayout>
      </Panel>

      <AppDialog
        open={isRegisterOpen}
        title={messages.query.registerTaskTitle}
        onClose={() => setIsRegisterOpen(false)}
        className="w-[24rem]"
      >
        <div className="space-y-4 p-4">
          <p className="text-sm text-text-secondary">{messages.query.registerTaskHint}</p>
          <FormField label={messages.query.namePlaceholder}>
            <input
              className="field-control"
              value={registerName}
              onChange={(event) => setRegisterName(event.target.value)}
            />
          </FormField>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setIsRegisterOpen(false)}>
              {messages.common.cancel}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={registerBusy || !registerName.trim()}
              onClick={() => void onRegister()}
            >
              {messages.query.registerTask}
            </Button>
          </div>
        </div>
      </AppDialog>

      <AppDialog
        open={newConnOpen}
        title={messages.apiExtract.newConnectionTitle}
        onClose={() => setNewConnOpen(false)}
        className="w-[26rem]"
      >
        <div className="space-y-3 p-4">
          <p className="text-sm text-text-secondary">{messages.apiExtract.newConnectionHint}</p>
          <FormField label={messages.connectionsPage.name}>
            <input className="field-control" value={newName} onChange={(event) => setNewName(event.target.value)} />
          </FormField>
          <FormField label={messages.apiExtract.baseUrl}>
            <input
              className="field-control technical"
              value={newBaseUrl}
              onChange={(event) => setNewBaseUrl(event.target.value)}
              placeholder="https://api.example.com"
            />
          </FormField>
          <FormField label={messages.apiExtract.token} example={messages.apiExtract.tokenHint}>
            <input
              className="field-control"
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
            />
          </FormField>
          <FormField label={messages.apiExtract.basicUser} example={messages.apiExtract.basicUserHint}>
            <input
              className="field-control"
              value={newUsername}
              onChange={(event) => setNewUsername(event.target.value)}
              autoComplete="off"
            />
          </FormField>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={() => setNewConnOpen(false)}>
              {messages.common.cancel}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={newSaving || !newName.trim() || !newBaseUrl.trim()}
              onClick={() => void onCreateConnection()}
            >
              {messages.common.save}
            </Button>
          </div>
        </div>
      </AppDialog>
    </PageShell>
  );
}
