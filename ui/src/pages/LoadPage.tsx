import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { BookmarkPlus, ChevronRight, Database, Eye, FileOutput, FileSpreadsheet, RotateCcw, Search } from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { CatalogTree } from "@/components/connections/CatalogTree";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { SplitLayout } from "@/layouts/SplitLayout";
import { Panel } from "@/components/ui/panel";
import { PaneHeader } from "@/components/ui/pane-header";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Select } from "@/components/ui/select";
import { PreviewGrid } from "@/components/transform/TransformEditorParts";
import { useLanguage } from "@/i18n/LanguageProvider";
import { toastError, toastSuccess } from "@/lib/notifications";
import { cn } from "@/lib/cn";
import { nextSequencedChipName } from "@/lib/chipSequence";
import { selectableClass } from "@/lib/selectable";
import { layout } from "@/lib/layout";
import { connectionApi } from "@/services/connections/connectionApi";
import { chipApi } from "@/services/chips/chipApi";
import { loadApi } from "@/services/load/loadApi";
import { datasetApi } from "@/services/transform/datasetApi";
import { datasetFromSlot, KIND_APPEARANCE, KIND_ORDER } from "@/features/transform/transformEditorModel";
import type { CatalogSelection, DataConnection } from "@/types/connection";
import type { ChipInputSlotResponse } from "@/types/chip";
import type { Dataset, FramePreview } from "@/types/dataset";
import type { LoadDefinition, LoadSpec } from "@/types/load";

export function LoadPage() {
  const { messages } = useLanguage();
  const t = messages.load;
  const navigate = useNavigate();
  const location = useLocation();
  const { workspaceId, editorChipId, id: routeId } = useParams<{ workspaceId: string; editorChipId: string; id: string }>();
  const workspaceMode = Boolean(workspaceId && editorChipId);
  const [loads, setLoads] = useState<LoadDefinition[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [inputSlot, setInputSlot] = useState<ChipInputSlotResponse | null>(null);
  const [expandedKinds, setExpandedKinds] = useState<Set<(typeof KIND_ORDER)[number]>>(new Set());
  const [kindSearch, setKindSearch] = useState<Record<(typeof KIND_ORDER)[number], string>>({
    upload: "", database: "", transform: "", api: "",
  });
  const [inputDatasetId, setInputDatasetId] = useState("");
  const [preview, setPreview] = useState<FramePreview | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [connections, setConnections] = useState<DataConnection[]>([]);
  const [editingId, setEditingId] = useState<string>();
  const [name, setName] = useState("");
  const [destinationType, setDestinationType] = useState<"database" | "file">("database");
  const [connectionId, setConnectionId] = useState("");
  const [database, setDatabase] = useState("");
  const [selectedTable, setSelectedTable] = useState<CatalogSelection | null>(null);
  const [table, setTable] = useState("");
  const [format, setFormat] = useState<"csv" | "parquet">("parquet");
  const [filename, setFilename] = useState("result.parquet");
  const [writeMode, setWriteMode] = useState<"append" | "truncate" | "upsert" | "recreate">("append");
  const [conflictKeys, setConflictKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const [loadResponse, connectionResponse, datasetResponse] = await Promise.all([loadApi.list(), connectionApi.getConnections(), datasetApi.list()]);
      setLoads(loadResponse.loads);
      setConnections(connectionResponse.connections.filter((item) => item.driver !== "http"));
      setDatasets(datasetResponse.datasets);
    } catch (error) { toastError(t.loadError, error); }
  }

  useEffect(() => { void refresh(); }, []);

  const spec = useMemo<LoadSpec>(() => destinationType === "database"
    ? { input_dataset_id: inputDatasetId || undefined, destination: { type: "database", connection_id: connectionId, database, table }, write_mode: writeMode, conflict_keys: writeMode === "upsert" ? conflictKeys : undefined }
    : { input_dataset_id: inputDatasetId || undefined, destination: { type: "file", format, filename }, write_mode: "replace" },
  [conflictKeys, connectionId, database, destinationType, filename, format, inputDatasetId, table, writeMode]);

  function reset() {
    setEditingId(undefined); setName(""); setDestinationType("database"); setConnectionId(""); setDatabase("");
    setTable(""); setSelectedTable(null); setFormat("parquet"); setFilename("result.parquet"); setWriteMode("append"); setConflictKeys([]);
    if (!workspaceMode) setInputDatasetId("");
  }

  function edit(load: LoadDefinition) {
    setEditingId(load.id); setName(load.name); setDestinationType(load.destination_type); setWriteMode(load.spec.write_mode === "replace" ? "truncate" : load.spec.write_mode); setConflictKeys(load.spec.conflict_keys ?? []);
    if (!workspaceMode) setInputDatasetId(load.spec.input_dataset_id ?? "");
    if (load.spec.destination.type === "database") {
      setConnectionId(load.spec.destination.connection_id); setDatabase(load.spec.destination.database ?? ""); setTable(load.spec.destination.table); setSelectedTable(null);
    } else { setFormat(load.spec.destination.format); setFilename(load.spec.destination.filename); }
  }

  async function save() {
    const resolvedName = name.trim() || (destinationType === "database"
      ? `${table.trim()} ${t.title}`
      : filename.trim());
    if (!resolvedName) return;
    setBusy(true);
    let createdDefinitionId: string | undefined;
    try {
      if (workspaceMode) {
        if (editingId) {
          await loadApi.update(editingId, { name: resolvedName, spec, input_chip_id: editorChipId });
        } else {
          const created = await loadApi.create({ name: resolvedName, spec, input_chip_id: editorChipId });
          createdDefinitionId = created.id;
        }
        toastSuccess(t.appliedToChip);
      } else {
        const created = await loadApi.create({ name: resolvedName, spec });
        createdDefinitionId = created.id;
        const catalog = await chipApi.listCatalog();
        await chipApi.register({
          name: nextSequencedChipName(
            catalog.chips,
            messages.workspace.defaultLoadChipName,
            (chip) => chip.kind === "load",
          ),
          kind: "load",
          load_definition_id: created.id,
          run_after: false,
        });
        toastSuccess(t.chipRegistered);
      }
      if (workspaceMode && workspaceId) {
        navigate(`/workspace/${workspaceId}`, { state: location.state });
        return;
      }
      navigate("/chips");
    } catch (error) {
      if (!workspaceMode && createdDefinitionId) {
        await loadApi.remove(createdDefinitionId).catch(() => undefined);
      }
      toastError(workspaceMode ? t.applyError : t.registerError, error);
    } finally { setBusy(false); }
  }

  const canSave = Boolean(inputDatasetId && (destinationType === "database" ? connectionId && table.trim() && (writeMode !== "upsert" || conflictKeys.length > 0) : filename.trim()));
  const inputDatasets = workspaceMode
    ? datasets.filter((item) => item.id === inputDatasetId)
    : datasets;
  const groupedInputs = KIND_ORDER.map((kind) => ({
    kind,
    items: inputDatasets.filter((item) => item.kind === kind),
  }));
  const kindLabel: Record<string, string> = {
    upload: messages.transform.kindUpload,
    database: messages.transform.kindDatabase,
    transform: messages.transform.kindTransform,
    api: messages.transform.kindApi,
  };
  function pickConnection(id: string) {
    setConnectionId(id);
    setDatabase(connections.find((item) => item.id === id)?.database_name ?? "");
    setSelectedTable(null);
    setTable("");
  }

  function pickTable(next: CatalogSelection | null) {
    setSelectedTable(next);
    if (next) setDatabase(next.database);
    setTable(next?.qualified ?? "");
  }

  useEffect(() => {
    if (!routeId || loads.length === 0) return;
    const row = loads.find((item) => item.id === routeId);
    if (row) edit(row);
  }, [routeId, loads]);

  useEffect(() => {
    if (!workspaceId || !editorChipId) return;
    void Promise.all([
      chipApi.getInputSlot(workspaceId, editorChipId),
      chipApi.list(workspaceId),
    ]).then(([slot, response]) => {
      setInputSlot(slot);
      const dataset = datasetFromSlot(slot);
      if (dataset) {
        setDatasets((current) => current.some((item) => item.id === dataset.id) ? current : [...current, dataset]);
        setInputDatasetId(dataset.id);
        if (KIND_ORDER.includes(dataset.kind as (typeof KIND_ORDER)[number])) {
          setExpandedKinds(new Set([dataset.kind as (typeof KIND_ORDER)[number]]));
        }
      }
      if (!routeId) {
        const chip = response.chips.find((item) => item.id === editorChipId);
        if (chip) setName(chip.name);
      }
    }).catch((error) => toastError(t.loadError, error));
  }, [editorChipId, routeId, workspaceId]);

  useEffect(() => {
    if (!inputDatasetId) { setPreview(null); return; }
    void datasetApi.inspect(inputDatasetId, 100, true)
      .then((response) => setPreview(response.preview))
      .catch((error) => toastError(t.loadError, error));
  }, [inputDatasetId]);

  return (
    <PageShell>
      <PageHeader
        iconName="jobs"
        eyebrow={t.eyebrow}
        title={t.title}
        description={t.description}
        actions={
          <>
            <Button variant="quiet" onClick={reset}>
              <RotateCcw className="size-3.5" />
              {t.reset}
            </Button>
            <Button variant="primary" disabled={busy || !canSave} onClick={() => void save()}>
              <BookmarkPlus className="size-3.5" />
              {busy ? messages.common.saving : workspaceMode ? t.applyToChip : t.registerChip}
            </Button>
            <span
              className="relative mx-5 h-8 w-px shrink-0 bg-gradient-to-b from-transparent via-border-strong to-transparent"
              aria-hidden="true"
            >
              <span className="absolute left-1/2 top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/70 ring-2 ring-surface" />
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant={destinationType === "database" ? "secondary" : "quiet"}
                onClick={() => setDestinationType("database")}
              >
                <Database className="size-3.5" />
                {t.database}
              </Button>
              <Button
                variant={destinationType === "file" ? "secondary" : "quiet"}
                onClick={() => setDestinationType("file")}
              >
                <FileOutput className="size-3.5" />
                {t.file}
              </Button>
            </div>
          </>
        }
      />
      <Panel tall className="overflow-hidden">
        <SplitLayout className="min-h-0 flex-1" defaultSizes={[layout.split.sidebar]}>
          <aside className="flex h-full min-h-0 flex-col overflow-hidden">
            <SplitLayout direction="vertical" className="h-full" defaultSizes={[layout.split.connections]} minSize={layout.split.minStack}>
              <div className="flex h-full min-h-0 flex-col overflow-hidden">
                <PaneHeader title={messages.common.connections} meta={messages.common.count(connections.length)} />
                <div className="scroll-pane min-h-0 flex-1 overflow-y-auto bg-surface">
                  {connections.length === 0 ? <p className="p-3 text-xs text-text-tertiary">{messages.empty.connections}</p> : connections.map((connection) => (
                    <button key={connection.id} type="button" className={cn("block w-full border-b border-border px-3 py-2 text-left", selectableClass(connection.id === connectionId))} onClick={() => pickConnection(connection.id)}>
                      <span className="block truncate text-[13px] text-text">{connection.name}</span>
                      <span className="mt-0.5 block truncate text-[11px] text-text-tertiary">{connection.driver} · {connection.database_name}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex h-full min-h-0 flex-col overflow-hidden">
                <PaneHeader title={messages.common.catalog} />
                <div className="scroll-pane min-h-0 flex-1 overflow-y-auto bg-surface">
                  {connectionId ? <CatalogTree connectionId={connectionId} selected={selectedTable} onPick={pickTable} /> : <p className="p-3 text-xs leading-5 text-text-tertiary">{t.connectionFirst}</p>}
                </div>
              </div>
            </SplitLayout>
          </aside>

          <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
            <PaneHeader title={editingId ? t.editDefinition : t.settings} description={t.formHint} />
            <div className="scroll-pane min-h-0 flex-1 overflow-auto bg-raised p-3">
              <div className="relative isolate mx-auto flex min-h-full w-full max-w-[90rem] overflow-hidden rounded-[1.6rem] border border-border/70 bg-gradient-to-br from-surface via-surface to-accent-subtle/40 p-2.5 shadow-[0_18px_48px_rgba(15,23,42,0.09),inset_0_1px_0_rgba(255,255,255,0.75)] ring-1 ring-white/40 dark:shadow-[0_20px_52px_rgba(0,0,0,0.28)] dark:ring-white/5">
                <span className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-accent/45 to-transparent" aria-hidden="true" />
                <span className="pointer-events-none absolute -right-20 -top-24 size-64 rounded-full bg-accent/5 blur-3xl" aria-hidden="true" />
                <div className="relative z-[1] grid min-h-[32rem] w-full flex-1 gap-2.5 lg:grid-cols-[minmax(18rem,0.82fr)_minmax(25rem,1.18fr)]">
                <section className="flex min-h-[32rem] flex-col overflow-hidden rounded-xl border border-border/80 bg-surface/95 shadow-[0_6px_18px_rgba(15,23,42,0.06)]">
                  <PaneHeader
                    title={messages.transform.catalog}
                    meta={messages.common.count(workspaceMode ? (inputSlot && inputSlot.mode !== "unwired" ? 1 : 0) : datasets.length)}
                    actions={
                      <Button
                        type="button"
                        variant="quiet"
                        className="gap-1.5"
                        disabled={!inputDatasetId || !preview}
                        onClick={() => setPreviewOpen(true)}
                      >
                        <Eye className="size-3.5" aria-hidden="true" />
                        {t.openPreview}
                      </Button>
                    }
                  />
                  <div className="scroll-pane min-h-0 flex-1 overflow-y-auto bg-surface">
                    {workspaceMode && inputSlot?.mode === "unwired" ? (
                      <p className="p-3 text-sm leading-6 text-text-secondary">{messages.transform.unwiredHint}</p>
                    ) : (
                      <div className="space-y-2 p-2">
                        {groupedInputs.map((group) => {
                          const appearance = KIND_APPEARANCE[group.kind];
                          const KindIcon = appearance.icon;
                          const expanded = expandedKinds.has(group.kind);
                          const query = kindSearch[group.kind].trim().toLocaleLowerCase();
                          const visibleItems = query
                            ? group.items.filter((item) => item.filename.toLocaleLowerCase().includes(query))
                            : group.items;
                          return (
                            <section key={group.kind} className="overflow-hidden rounded-lg border border-border bg-surface">
                              <button
                                type="button"
                                aria-expanded={expanded}
                                className={cn(
                                  "flex w-full items-center gap-2 px-3 py-2.5 text-left transition-[filter] hover:brightness-95",
                                  expanded && "border-b",
                                  appearance.header,
                                )}
                                onClick={() => setExpandedKinds((current) => {
                                  const next = new Set(current);
                                  if (expanded) next.delete(group.kind); else next.add(group.kind);
                                  return next;
                                })}
                              >
                                <KindIcon className="size-4 shrink-0" aria-hidden="true" />
                                <span className="min-w-0 flex-1 text-sm font-bold">{kindLabel[group.kind]}</span>
                                <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums", appearance.count)}>
                                  {group.items.length}
                                </span>
                                <ChevronRight className={cn("size-4 shrink-0 transition-transform", expanded && "rotate-90")} aria-hidden="true" />
                              </button>
                              {expanded ? (
                                <div className="border-b border-border bg-raised p-2.5">
                                  <div className="group flex h-9 items-center overflow-hidden rounded-lg border border-border bg-surface shadow-sm focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
                                    <span className="grid h-full w-9 shrink-0 place-items-center border-r border-border bg-subtle text-text-tertiary group-focus-within:text-accent">
                                      <Search className="size-3.5" aria-hidden="true" />
                                    </span>
                                    <input
                                      type="search"
                                      className="min-w-0 flex-1 bg-transparent px-3 text-[13px] text-text outline-none placeholder:text-text-tertiary"
                                      value={kindSearch[group.kind]}
                                      placeholder={messages.transform.searchFiles}
                                      onChange={(event) => setKindSearch((current) => ({ ...current, [group.kind]: event.target.value }))}
                                    />
                                  </div>
                                </div>
                              ) : null}
                              {expanded && visibleItems.length === 0 ? (
                                <p className="px-3 py-4 text-center text-xs text-text-tertiary">{messages.transform.noMatchingFiles}</p>
                              ) : null}
                              {expanded && visibleItems.map((dataset) => (
                                <button
                                  key={dataset.id}
                                  type="button"
                                  className={cn(
                                    "flex w-full min-w-0 items-start gap-2 border-b border-border px-3 py-2.5 text-left last:border-b-0",
                                    selectableClass(inputDatasetId === dataset.id),
                                  )}
                                  disabled={workspaceMode}
                                  onClick={() => setInputDatasetId(dataset.id)}
                                >
                                  <FileSpreadsheet className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
                                  <span className="min-w-0 flex-1">
                                    <span className="block break-all text-[13px] font-medium leading-4">
                                      {dataset.filename}
                                      {dataset.status === "planned" ? <span className="ml-1 text-[11px] font-normal text-accent">({messages.transform.plannedInput})</span> : null}
                                    </span>
                                    <span className="mt-0.5 block truncate text-[11px] text-text-tertiary">
                                      {dataset.status === "planned"
                                        ? messages.transform.schemaOnlyHint
                                        : dataset.origin?.connection_name
                                          ? `${dataset.origin.connection_name} · ${dataset.origin.table_name}`
                                          : dataset.row_count != null
                                            ? messages.common.rows(dataset.row_count)
                                            : dataset.id.slice(0, 8)}
                                    </span>
                                  </span>
                                </button>
                              ))}
                            </section>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </section>

                <section className="overflow-hidden rounded-xl border border-border/80 bg-surface/95 shadow-[0_6px_18px_rgba(15,23,42,0.06)]">
                  <PaneHeader title={t.destinationSettings} description={t.destinationSettingsHint} />
                  <div className="grid gap-5 p-5">
                    {destinationType === "database" && !connectionId ? <p className="text-xs text-text-tertiary">{t.connectionFirst}</p> : null}
                    {destinationType === "database" ? <>
                      <FormField label={t.table} hint={t.tableCatalogOnly}><input className="field-control technical cursor-default" value={table} readOnly aria-readonly="true" placeholder={t.tableCatalogPlaceholder} disabled={!connectionId} /></FormField>
                      <FormField label={t.writeMode} hint={t.writeModeHint}><Select value={writeMode} onChange={(v) => setWriteMode(v as typeof writeMode)} options={[{ value: "append", label: t.append }, { value: "truncate", label: t.truncate }, { value: "upsert", label: t.upsert }, { value: "recreate", label: t.recreate }]} disabled={!connectionId} /></FormField>
                      {writeMode === "upsert" ? (
                        <FormField label={t.conflictKeys} hint={t.conflictKeysHint}>
                          <div className="flex min-h-10 flex-wrap gap-2 rounded-lg border border-border bg-surface p-2">
                            {(preview?.columns ?? []).map((column) => {
                              const selected = conflictKeys.includes(column.name);
                              return <button key={column.name} type="button" className={cn("rounded-md border px-2 py-1 text-xs transition-colors", selected ? "border-accent bg-accent-subtle font-semibold text-accent" : "border-border text-text-secondary hover:border-accent/50 hover:bg-subtle")} onClick={() => setConflictKeys((current) => selected ? current.filter((key) => key !== column.name) : [...current, column.name])}>{column.name}</button>;
                            })}
                            {!preview?.columns.length ? <span className="px-1 py-1 text-xs text-text-tertiary">{t.noConflictColumns}</span> : null}
                          </div>
                        </FormField>
                      ) : null}
                    </> : <>
                      <FormField label={t.format}><Select value={format} onChange={(v) => { const next = v as "csv" | "parquet"; setFormat(next); setFilename(`result.${next}`); }} options={[{ value: "parquet", label: "Parquet" }, { value: "csv", label: "CSV" }]} /></FormField>
                      <FormField label={t.filename}><input className="field-control technical" value={filename} onChange={(e) => setFilename(e.target.value)} /></FormField>
                      <p className="rounded-lg border border-border bg-subtle/40 p-3 text-xs leading-5 text-text-secondary">{t.fileHint}</p>
                    </>}
                  </div>
                </section>
                </div>
              </div>
            </div>
          </section>
        </SplitLayout>
      </Panel>
      <AppDialog
        open={previewOpen}
        title={t.inputPreview}
        className="h-[min(42rem,88vh)] w-[min(72rem,94vw)]"
        minWidth={720}
        minHeight={420}
        onClose={() => setPreviewOpen(false)}
      >
        <div className="h-full min-h-0 overflow-auto p-4">
          <PreviewGrid preview={preview} empty={t.pickInputDataset} />
        </div>
      </AppDialog>
    </PageShell>
  );
}
