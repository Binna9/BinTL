import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BookmarkPlus, Braces, Clock3, Code2, Eye, FileDown, FileJson2, Globe2, ListFilter, Plus, RotateCcw, Settings2, Trash2 } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { PaneHeader } from "@/components/ui/pane-header";
import { Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { useConnections } from "@/hooks/connections/useConnections";
import { isExtractActive } from "@/hooks/extract/useExtracts";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { extractSourceType, nextSequencedChipName } from "@/lib/chipSequence";
import { DELIMITER_VALUES } from "@/lib/delimiter";
import { layout } from "@/lib/layout";
import { toastError, toastSuccess } from "@/lib/notifications";
import { selectableClass } from "@/lib/selectable";
import { extractApi } from "@/services/extract/extractApi";
import { chipApi } from "@/services/chips/chipApi";
import type { ExtractRecord, HttpKv, HttpPreviewResponse, HttpSource } from "@/types/extract";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
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
    <div className="space-y-2.5">
      {rows.map((row, index) => (
        <div key={index} className="group grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] items-center gap-2">
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
            className="inline-flex size-9 items-center justify-center rounded-lg border border-transparent text-text-tertiary opacity-70 transition hover:border-border hover:bg-raised hover:text-danger group-hover:opacity-100"
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
            aria-label="remove"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
      <Button type="button" variant="secondary" className="mt-1 gap-1.5 border-dashed" onClick={() => onChange([...rows, emptyKv()])}>
        <Plus className="size-3.5" />
        {addLabel}
      </Button>
    </div>
  );
}

function RequestSection({
  title,
  children,
  className,
  icon,
  meta,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  icon?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <section className={cn("overflow-hidden rounded-xl border border-border/80 bg-surface shadow-[0_1px_2px_rgba(15,23,42,0.03)]", className)}>
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border/70 bg-raised/70 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon ? <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent-subtle text-accent">{icon}</span> : null}
          <h2 className="truncate text-[13px] font-semibold text-text">{title}</h2>
        </div>
        {meta ? <div className="shrink-0 text-[11px] text-text-tertiary">{meta}</div> : null}
      </div>
      <div className="p-4 md:p-5">{children}</div>
    </section>
  );
}

export function ApiExtractPage() {
  const { messages } = useLanguage();
  const { connections } = useConnections();
  const httpConnections = useMemo(
    () => connections.filter((connection) => connection.driver === "http"),
    [connections],
  );

  const [browseId, setBrowseId] = useState("");
  const [method, setMethod] = useState<string>("GET");
  const [requestType, setRequestType] = useState<"rest" | "graphql">("rest");
  const [path, setPath] = useState("");
  const [query, setQuery] = useState<HttpKv[]>([emptyKv()]);
  const [headers, setHeaders] = useState<HttpKv[]>([emptyKv()]);
  const [body, setBody] = useState("");
  const [bodyMode, setBodyMode] = useState<"json" | "raw" | "urlencoded" | "multipart">("json");
  const [form, setForm] = useState<HttpKv[]>([emptyKv()]);
  const [timeoutMs, setTimeoutMs] = useState(60_000);
  const [graphqlQuery, setGraphqlQuery] = useState("");
  const [graphqlVariables, setGraphqlVariables] = useState("{}");
  const [graphqlOperationName, setGraphqlOperationName] = useState("");
  const [recordsPath, setRecordsPath] = useState("");
  const [limit, setLimit] = useState<(typeof PREVIEW_LIMITS)[number]>(50);
  const [delimiter, setDelimiter] = useState(",");
  const [header, setHeader] = useState(true);
  const [addSequence, setAddSequence] = useState(false);
  const [exportName, setExportName] = useState("");
  const [preview, setPreview] = useState<HttpPreviewResponse | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [info, setInfo] = useState("");
  const [running, setRunning] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractId, setExtractId] = useState<string | null>(null);
  const [extractRow, setExtractRow] = useState<ExtractRecord | null>(null);
  const [isRegisterOpen, setIsRegisterOpen] = useState(false);
  const [registerName, setRegisterName] = useState("");
  const [registerBusy, setRegisterBusy] = useState(false);
  const browseInitialized = useRef(false);

  useEffect(() => {
    if (browseInitialized.current || !httpConnections[0]) return;
    setBrowseId(httpConnections[0].id);
    browseInitialized.current = true;
  }, [httpConnections]);

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
    let variables: Record<string, unknown> = {};
    if (requestType === "graphql" && graphqlVariables.trim()) {
      try {
        variables = JSON.parse(graphqlVariables) as Record<string, unknown>;
      } catch {
        throw new Error(messages.apiExtract.graphqlVariablesInvalid);
      }
    }
    return {
      type: "http",
      request_type: requestType,
      method,
      path: path.trim(),
      query: compactKv(query),
      headers: compactKv(headers),
      body: method === "GET" || method === "HEAD" ? null : body,
      body_mode: bodyMode,
      form: compactKv(form),
      timeout_ms: timeoutMs,
      graphql_query: requestType === "graphql" ? graphqlQuery : "",
      graphql_variables: variables,
      graphql_operation_name: requestType === "graphql" ? graphqlOperationName : "",
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
        body_mode: source.body_mode,
        form: source.form,
        timeout_ms: source.timeout_ms,
        request_type: source.request_type,
        graphql_query: source.graphql_query,
        graphql_variables: source.graphql_variables,
        graphql_operation_name: source.graphql_operation_name,
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
      setPreviewOpen(true);
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

  function resetRequest() {
    setMethod("GET");
    setRequestType("rest");
    setPath("");
    setQuery([emptyKv()]);
    setHeaders([emptyKv()]);
    setBody("");
    setBodyMode("json");
    setForm([emptyKv()]);
    setTimeoutMs(60_000);
    setGraphqlQuery("");
    setGraphqlVariables("{}");
    setGraphqlOperationName("");
    setRecordsPath("");
    setLimit(50);
    setDelimiter(",");
    setHeader(true);
    setAddSequence(false);
    setExportName("");
    setPreview(null);
    setPreviewOpen(false);
    setInfo("");
    setExtractId(null);
    setExtractRow(null);
    setIsRegisterOpen(false);
    setRegisterName("");
  }

  async function openRegister() {
    try {
      const response = await chipApi.listCatalog();
      setRegisterName(nextSequencedChipName(
        response.chips,
        messages.apiExtract.defaultChipName,
        (chip) => chip.kind === "extract" && extractSourceType(chip) === "http",
      ));
    } catch (err) {
      setRegisterName(messages.apiExtract.defaultChipName(1));
      toastError(messages.workspace.loadError, err);
    }
    setIsRegisterOpen(true);
  }

  const extractBusy = extracting || (extractRow ? isExtractActive(extractRow.status) : false);
  const canRun = Boolean(browseId);
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
        actions={
          <>
            <Button
              type="button"
              variant="secondary"
              className="gap-1.5"
              disabled={running || extractBusy}
              onClick={resetRequest}
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {messages.apiExtract.reset}
            </Button>
            <Button
              type="button"
              className="gap-1.5"
              disabled={!canRun || running}
              onClick={() => void runPreview()}
            >
              <Eye className="size-3.5" />
              {running ? messages.apiExtract.calling : messages.apiExtract.previewTitle}
            </Button>
            <Button
              type="button"
              className="gap-1.5"
              disabled={!canRun}
              onClick={() => void openRegister()}
            >
              <BookmarkPlus className="size-3.5" />
              {messages.query.registerTask}
            </Button>
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
          </>
        }
      />

      <Panel tall className="overflow-hidden">
        <SplitLayout className="min-h-0 flex-1" defaultSizes={[layout.split.sidebar]}>
          <aside className="flex h-full min-h-0 flex-col overflow-hidden border-r border-border">
            <PaneHeader
              title={messages.apiExtract.connections}
              meta={messages.common.count(httpConnections.length)}
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
                    onClick={() => setBrowseId((current) => (current === connection.id ? "" : connection.id))}
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
            <PaneHeader
              title={messages.apiExtract.detailTitle}
              meta={browseId ? httpConnections.find((connection) => connection.id === browseId)?.name : undefined}
            />
            <div className="scroll-pane min-h-0 flex-1 overflow-y-auto bg-subtle/25 p-4 md:p-5">
              <div className="mx-auto flex max-w-5xl flex-col gap-4">
                <RequestSection
                  title={messages.apiExtract.apiInfo}
                  icon={<Globe2 className="size-3.5" aria-hidden="true" />}
                  meta={<span className="rounded-md border border-border bg-surface px-2 py-1 font-mono font-semibold text-text-secondary">{requestType === "graphql" ? "GraphQL · POST" : `${requestType.toUpperCase()} · ${method}`}</span>}
                  className="ring-1 ring-accent/5"
                >
                  <div className="grid gap-3 md:grid-cols-[7rem_7rem_minmax(0,1fr)]">
                    <FormField label={messages.apiExtract.requestType}>
                      <Select
                        value={requestType}
                        options={[{ value: "rest", label: "REST" }, { value: "graphql", label: "GraphQL" }]}
                        onChange={(value) => setRequestType(value as "rest" | "graphql")}
                      />
                    </FormField>
                    <FormField label={messages.apiExtract.method}>
                      <Select
                        value={requestType === "graphql" ? "POST" : method}
                        options={METHODS.map((value) => ({ value, label: value }))}
                        onChange={setMethod}
                      />
                    </FormField>
                    <FormField label={messages.apiExtract.path}>
                      <input
                        className="field-control technical"
                        value={path}
                        placeholder="/connect/test"
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
                </RequestSection>

                <section className="grid items-start gap-4 lg:grid-cols-2">
                  <RequestSection title={messages.apiExtract.queryParams} icon={<ListFilter className="size-3.5" aria-hidden="true" />} meta={<span>{compactKv(query).length}</span>}>
                    <KvEditor
                      rows={query}
                      onChange={setQuery}
                      nameLabel={messages.apiExtract.paramName}
                      valueLabel={messages.apiExtract.paramValue}
                      addLabel={messages.apiExtract.addParam}
                    />
                  </RequestSection>
                  <RequestSection title={messages.apiExtract.headers} icon={<Code2 className="size-3.5" aria-hidden="true" />} meta={<span>{compactKv(headers).length}</span>}>
                    <KvEditor
                      rows={headers}
                      onChange={setHeaders}
                      nameLabel={messages.apiExtract.headerName}
                      valueLabel={messages.apiExtract.headerValue}
                      addLabel={messages.apiExtract.addHeader}
                    />
                  </RequestSection>
                </section>

                <RequestSection title={messages.apiExtract.requestOptions} icon={<Settings2 className="size-3.5" aria-hidden="true" />}>
                  <div className="flex max-w-sm items-end gap-3 rounded-lg border border-border/70 bg-raised/50 p-3">
                    <span className="mb-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-surface text-text-tertiary shadow-sm"><Clock3 className="size-4" aria-hidden="true" /></span>
                    <FormField label={messages.apiExtract.timeout}>
                      <input className="field-control technical" type="number" min="1000" max="300000" value={timeoutMs} onChange={(event) => setTimeoutMs(Number(event.target.value) || 60_000)} />
                    </FormField>
                  </div>
                </RequestSection>
                {requestType === "graphql" ? (
                  <RequestSection title={messages.apiExtract.graphql} icon={<Braces className="size-3.5" aria-hidden="true" />}>
                    <div className="grid gap-4 lg:grid-cols-2">
                      <FormField label={messages.apiExtract.graphqlQuery}>
                        <textarea className="field-control technical min-h-[12rem] font-mono text-[12px]" value={graphqlQuery} placeholder="query Users($first: Int!) { users(first: $first) { nodes { id name } } }" onChange={(event) => setGraphqlQuery(event.target.value)} />
                      </FormField>
                      <div className="flex flex-col gap-4">
                        <FormField label={messages.apiExtract.graphqlVariables}>
                          <textarea className="field-control technical min-h-[8rem] font-mono text-[12px]" value={graphqlVariables} onChange={(event) => setGraphqlVariables(event.target.value)} />
                        </FormField>
                        <FormField label={messages.apiExtract.graphqlOperationName}>
                          <input className="field-control technical" value={graphqlOperationName} onChange={(event) => setGraphqlOperationName(event.target.value)} />
                        </FormField>
                      </div>
                    </div>
                  </RequestSection>
                ) : method === "GET" || method === "HEAD" ? null : (
                  <RequestSection title={messages.apiExtract.requestBody} icon={<FileJson2 className="size-3.5" aria-hidden="true" />}>
                    <FormField label={messages.apiExtract.bodyType}>
                      <Select value={bodyMode} options={[{ value: "json", label: "JSON" }, { value: "raw", label: messages.apiExtract.rawText }, { value: "urlencoded", label: "x-www-form-urlencoded" }, { value: "multipart", label: "multipart/form-data" }]} onChange={(value) => setBodyMode(value as typeof bodyMode)} />
                    </FormField>
                    {bodyMode === "urlencoded" || bodyMode === "multipart" ? (
                      <div className="mt-3"><KvEditor rows={form} onChange={setForm} nameLabel={messages.apiExtract.fieldName} valueLabel={messages.apiExtract.fieldValue} addLabel={messages.apiExtract.addField} /></div>
                    ) : <div className="mt-3"><FormField label={messages.apiExtract.body}>
                      <textarea
                        className="field-control technical min-h-[8rem] font-mono text-[12px]"
                        value={body}
                        placeholder='{"page":1}'
                        onChange={(event) => setBody(event.target.value)}
                      />
                    </FormField></div>}
                  </RequestSection>
                )}

              </div>
            </div>
          </div>
        </SplitLayout>
      </Panel>

      <AppDialog
        open={previewOpen}
        title={messages.apiExtract.previewTitle}
        icon={<Eye className="size-4 text-accent" aria-hidden="true" />}
        className="h-[min(42rem,88vh)] w-[min(72rem,94vw)]"
        minWidth={520}
        minHeight={360}
        onClose={() => setPreviewOpen(false)}
        headerExtra={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              className="!w-[4.75rem] technical"
              value={String(limit)}
              options={PREVIEW_LIMITS.map((value) => ({ value: String(value), label: String(value) }))}
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
          </div>
        }
        footer={
          <Button type="button" variant="secondary" onClick={() => setPreviewOpen(false)}>
            {messages.common.close}
          </Button>
        }
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {info ? <p className="border-b border-border px-4 py-2 text-xs text-text-secondary">{info}</p> : null}
          <div className="min-h-0 flex-1 overflow-hidden p-4">
            {!preview ? (
              <p className="px-4 py-12 text-center text-[13px] text-text-tertiary">
                {messages.apiExtract.previewHint}
              </p>
            ) : (
              <DataGrid className="h-full min-h-64" headers={preview.columns} columnWidths={resultWidths}>
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
        </div>
      </AppDialog>

      <AppDialog
        open={isRegisterOpen}
        title={messages.query.registerTaskTitle}
        icon={<BookmarkPlus className="size-4 text-accent" aria-hidden="true" />}
        onClose={() => setIsRegisterOpen(false)}
        className="w-[min(22rem,92vw)]"
        minWidth={320}
        minHeight={240}
        zIndex={120}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setIsRegisterOpen(false)}>
              {messages.common.cancel}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={registerBusy || !registerName.trim()}
              onClick={() => void onRegister()}
            >
              {registerBusy ? messages.common.saving : messages.common.save}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 p-4">
          <p className="text-[11px] leading-5 text-text-tertiary">{messages.query.registerTaskHint}</p>
          <FormField label={messages.workspace.chipName}>
            <input
              className="field-control"
              value={registerName}
              autoFocus
              placeholder={messages.query.namePlaceholder}
              onChange={(event) => setRegisterName(event.target.value)}
            />
          </FormField>
          <dl className="space-y-2 border-t border-border/60 pt-3 text-[11px] text-text-tertiary">
            <div className="flex gap-2">
              <dt className="w-14 shrink-0">{messages.workspace.connection}</dt>
              <dd className="min-w-0 truncate text-text-secondary">
                {httpConnections.find((connection) => connection.id === browseId)?.name ?? "—"}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-14 shrink-0">{messages.apiExtract.path}</dt>
              <dd className="min-w-0 truncate font-mono text-text-secondary">{path || "—"}</dd>
            </div>
          </dl>
        </div>
      </AppDialog>

    </PageShell>
  );
}
