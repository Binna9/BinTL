import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, BookmarkPlus, ChevronRight, FileOutput, FileSpreadsheet, Play, Settings2, ShieldCheck } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { PaneHeader } from "@/components/ui/pane-header";
import { Button } from "@/components/ui/button";
import { ColumnChips } from "@/components/ColumnChips";
import { FormField } from "@/components/ui/form-field";
import { AppDialog } from "@/components/AppDialog";
import { datasetApi } from "@/services/transform/datasetApi";
import { validationApi, type ValidationReport } from "@/services/validation/validationApi";
import { chipApi } from "@/services/chips/chipApi";
import { workspaceApi } from "@/services/workspace/workspaceApi";
import { toastError, toastSuccess } from "@/lib/notifications";
import { cn } from "@/lib/cn";
import { selectableClass } from "@/lib/selectable";
import { KIND_APPEARANCE, KIND_ORDER, datasetFromSlot } from "@/features/transform/transformEditorModel";
import { useLanguage } from "@/i18n/LanguageProvider";
import { nextSequencedChipName } from "@/lib/chipSequence";
import { isChipNameConflict } from "@/services/httpClient";
import type { ChipInputSlotResponse } from "@/types/chip";
import type { Dataset } from "@/types/dataset";

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function toggleList(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function storedFileId(id: string): string {
  return !id || id.startsWith("contract:") ? "" : id;
}

function slotColumns(slot: ChipInputSlotResponse | null): string[] {
  if (!slot) return [];
  const dataset = slot.dataset as Dataset | undefined;
  return unique([
    ...(slot.columns?.map((column) => column.name) ?? []),
    ...(dataset?.columns?.map((column) => column.name) ?? []),
  ]);
}

function listedColumns(datasets: Dataset[], id: string): string[] {
  return datasets.find((item) => item.id === id)?.columns.map((column) => column.name) ?? [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

function boolFlag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function keepKnown(values: string[], choices: string[]): string[] {
  if (!choices.length) return values;
  return values.filter((value) => choices.includes(value));
}

export function ValidationPage() {
  const navigate = useNavigate();
  const { workspaceId, editorChipId } = useParams();
  const editingChip = Boolean(editorChipId);
  const canvasMode = Boolean(workspaceId && editorChipId);
  const { messages } = useLanguage();
  const t = messages.validation;
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [keys, setKeys] = useState<string[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [compareRowCount, setCompareRowCount] = useState(true);
  const [compareSchema, setCompareSchema] = useState(true);
  const [fileColumns, setFileColumns] = useState<string[]>([]);
  const [sourceSlot, setSourceSlot] = useState<ChipInputSlotResponse | null>(null);
  const [targetSlot, setTargetSlot] = useState<ChipInputSlotResponse | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registerName, setRegisterName] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const [draftRowCount, setDraftRowCount] = useState(true);
  const [draftSchema, setDraftSchema] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await datasetApi.list();
        if (cancelled) return;
        setDatasets(result.datasets.filter((item) => item.available && (!workspaceId || item.workspace_id === workspaceId)));
        if (!editorChipId) return;
        if (!workspaceId) {
          const chip = await chipApi.get(editorChipId);
          if (cancelled) return;
          const config = chip.config;
          setSourceId(typeof config.source_data_file_id === "string" ? config.source_data_file_id : "");
          setKeys(stringList(config.keys));
          setColumns(stringList(config.columns));
          setCompareRowCount(boolFlag(config.compare_row_count, true));
          setCompareSchema(boolFlag(config.compare_schema, true));
          return;
        }
        const emptySlot: ChipInputSlotResponse = { mode: "unwired" };
        const [chip, target, workspace, workspaceChips, source] = await Promise.all([
          chipApi.get(editorChipId),
          chipApi.getInputSlot(workspaceId, editorChipId).catch(() => emptySlot),
          workspaceApi.get(workspaceId),
          chipApi.list(workspaceId),
          chipApi.getInputSlot(workspaceId, editorChipId, "source").catch(() => emptySlot),
        ]);
        if (cancelled) return;
        const config = chip.config;
        setKeys(stringList(config.keys));
        setColumns(stringList(config.columns));
        setCompareRowCount(boolFlag(config.compare_row_count, true));
        setCompareSchema(boolFlag(config.compare_schema, true));
        setSourceSlot(source);
        setTargetSlot(target);
        const incoming = (workspace.edges ?? []).filter((edge) => edge.kind === "data" && edge.to_chip_id === editorChipId);
        const sourceEdge = incoming.find((edge) => edge.to_port === "source") ?? incoming[0];
        const targetEdge = incoming.find((edge) => edge.to_port === "target") ?? incoming[1];
        const connectedDatasetId = (edge: typeof sourceEdge) => edge
          ? workspaceChips.chips.find((item) => item.id === edge.from_chip_id)?.output?.dataset_id ?? ""
          : "";
        const sourceDataset = datasetFromSlot(source);
        const targetDataset = datasetFromSlot(target);
        setDatasets((current) => {
          const next = [...current];
          for (const dataset of [sourceDataset, targetDataset]) {
            if (dataset && !next.some((item) => item.id === dataset.id)) next.push(dataset);
          }
          return next;
        });
        setSourceId(sourceDataset?.id || connectedDatasetId(sourceEdge) || (typeof config.source_data_file_id === "string" ? config.source_data_file_id : ""));
        setTargetId(targetDataset?.id || connectedDatasetId(targetEdge) || "");
      } catch (error) {
        toastError(t.loadError, error);
      }
    })();
    return () => { cancelled = true; };
  }, [editorChipId, t.loadError, workspaceId]);

  useEffect(() => {
    const ids = unique([storedFileId(sourceId), storedFileId(targetId)]);
    if (!ids.length) {
      setFileColumns([]);
      return;
    }
    let cancelled = false;
    void Promise.all(ids.map((id) => datasetApi.inspect(id, 1, true).catch(() => null))).then((results) => {
      if (cancelled) return;
      setFileColumns(unique(results.flatMap((item) => item?.dataset.columns.map((column) => column.name) ?? [])));
    });
    return () => { cancelled = true; };
  }, [sourceId, targetId]);

  const kindLabels = useMemo<Record<string, string>>(() => ({
    upload: messages.transform.kindUpload,
    database: messages.transform.kindDatabase,
    api: messages.transform.kindApi,
    transform: messages.transform.kindTransform,
  }), [messages.transform]);
  const sourceWired = canvasMode && sourceSlot?.mode !== "unwired";
  const targetWired = canvasMode && targetSlot?.mode !== "unwired";
  const targetIsLoad = canvasMode && targetSlot?.source_chip_kind === "load";
  const sourceFileId = storedFileId(sourceId);
  const targetFileId = storedFileId(targetId);
  const sourceColumns = unique([
    ...slotColumns(sourceSlot),
    ...listedColumns(datasets, sourceId),
  ]);
  const targetColumns = unique([
    ...slotColumns(targetSlot),
    ...listedColumns(datasets, targetId),
  ]);
  const columnChoices = unique(
    targetIsLoad
      ? [
          ...(targetColumns.length
            ? sourceColumns.filter((name) => targetColumns.includes(name))
            : sourceColumns),
          ...fileColumns,
        ]
      : [
          ...sourceColumns,
          ...targetColumns,
          ...fileColumns,
        ],
  );
  const columnKey = columnChoices.join("\0");
  const pickerEmpty = canvasMode ? t.noConnectedColumns : t.noFileColumns;
  const chipKeys = keepKnown(keys, columnChoices);
  const chipColumns = keepKnown(columns, columnChoices);
  const canSave = Boolean(editingChip && chipKeys.length && !busy && (sourceWired || sourceFileId));
  const canRun = Boolean(!editingChip && sourceFileId && targetFileId && sourceFileId !== targetFileId && chipKeys.length && !busy);
  const canRegister = Boolean(!editingChip && sourceFileId && chipKeys.length && !busy);

  useEffect(() => {
    if (!columnChoices.length) return;
    setKeys((current) => keepKnown(current, columnChoices));
    setColumns((current) => keepKnown(current, columnChoices));
  }, [columnKey]);

  function validationConfig() {
    return {
      source_data_file_id: sourceFileId,
      keys: chipKeys,
      columns: chipColumns,
      compare_row_count: compareRowCount,
      compare_schema: compareSchema,
    };
  }

  async function run() {
    if (!canRun) return;
    setBusy(true);
    try {
      const response = await validationApi.run({
        target_data_file_id: targetFileId,
        ...validationConfig(),
      });
      setReport(response.report);
    } catch (error) {
      toastError(t.runError, error);
    } finally {
      setBusy(false);
    }
  }

  async function saveChip() {
    if (!editorChipId) return;
    setBusy(true);
    try {
      await chipApi.update(editorChipId, { config: validationConfig() });
      toastSuccess(t.appliedToChip);
      navigate(workspaceId ? `/workspace/${workspaceId}` : "/chips");
    } catch (error) {
      toastError(t.applyError, error);
    } finally {
      setBusy(false);
    }
  }

  function openDetails() {
    setDraftRowCount(compareRowCount);
    setDraftSchema(compareSchema);
    setDetailOpen(true);
  }

  function applyDetails() {
    setCompareRowCount(draftRowCount);
    setCompareSchema(draftSchema);
    setDetailOpen(false);
  }

  const detailSummary = [
    compareRowCount ? t.compareRows : null,
    compareSchema ? t.compareSchema : null,
  ].filter((item): item is string => Boolean(item)).join(" · ") || t.noExtraChecks;

  async function openRegister() {
    try {
      const catalog = await chipApi.listCatalog();
      setRegisterName(nextSequencedChipName(
        catalog.chips,
        messages.workspace.defaultValidationChipName,
        (chip) => chip.kind === "validation",
      ));
    } catch {
      setRegisterName(messages.workspace.defaultValidationChipName(1));
    }
    setRegisterOpen(true);
  }

  async function registerChip() {
    if (!canRegister || !registerName.trim()) return;
    setBusy(true);
    try {
      await chipApi.register({
        name: registerName.trim(),
        kind: "validation",
        config: validationConfig(),
      });
      setRegisterOpen(false);
      toastSuccess(t.chipRegistered);
    } catch (error) {
      if (isChipNameConflict(error)) toastError(messages.workspace.duplicateChipName);
      else toastError(t.registerError, error);
    } finally {
      setBusy(false);
    }
  }

  const headerActions = (
    <>
      {editingChip ? (
        <Button variant="quiet" onClick={() => navigate(workspaceId ? `/workspace/${workspaceId}` : "/chips")}>
          <ArrowLeft className="size-3.5" />
          {workspaceId ? t.backToWorkspace : messages.chips.backToChips}
        </Button>
      ) : null}
      {editingChip ? (
        <Button variant="primary" disabled={!canSave} onClick={() => void saveChip()}>
          <BookmarkPlus className="size-3.5" />
          {busy ? messages.common.saving : t.applyToChip}
        </Button>
      ) : (
        <>
          <Button variant="secondary" disabled={!canRegister} onClick={() => void openRegister()}>
            <BookmarkPlus className="size-3.5" />
            {t.registerChip}
          </Button>
          <Button variant="primary" disabled={!canRun} onClick={() => void run()}>
            <Play className="size-3.5" />
            {busy ? messages.common.running : messages.common.run}
          </Button>
        </>
      )}
    </>
  );

  return <PageShell>
    <PageHeader iconName="validation" eyebrow={t.eyebrow} title={t.title} description={t.description} actions={headerActions} />
    <Panel tall className="overflow-hidden">
      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-2 overflow-hidden">
        <aside className="grid h-full min-h-0 min-w-0 grid-cols-2 overflow-hidden border-r border-border">
          <div className="min-h-0 min-w-0 overflow-hidden border-r border-border">
            <DatasetPicker title={t.source} datasets={datasets} value={sourceId} onChange={setSourceId} kindLabels={kindLabels} disabled={sourceWired} />
          </div>
          <div className="min-h-0 min-w-0 overflow-hidden">
            {targetIsLoad ? (
              <LoadTargetPane slot={targetSlot} />
            ) : (
              <DatasetPicker title={t.target} datasets={datasets} value={targetId} onChange={setTargetId} kindLabels={kindLabels} disabled={targetWired} />
            )}
          </div>
        </aside>
        <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
          <PanelHeader title={t.settings} description={canvasMode ? t.canvasHint : t.hint} />
          <PanelBody className="scroll-pane min-h-0 flex-1 overflow-auto bg-raised">
            <div className="mx-auto grid max-w-3xl gap-5 rounded-2xl border border-border bg-surface p-6 shadow-sm">
              <FormField label={t.keys} hint={canvasMode ? t.canvasKeysHint : t.keysHint}>
                <ColumnChips
                  choices={columnChoices}
                  selected={chipKeys}
                  empty={pickerEmpty}
                  onToggle={(name) => setKeys((current) => {
                    const next = toggleList(current, name);
                    setColumns((cols) => cols.filter((column) => !next.includes(column)));
                    return next;
                  })}
                />
              </FormField>
              <FormField label={t.columns} hint={t.columnsHint}>
                <ColumnChips
                  choices={columnChoices}
                  selected={chipColumns}
                  disabledNames={chipKeys}
                  empty={pickerEmpty}
                  onToggle={(name) => setColumns((current) => toggleList(current, name))}
                />
              </FormField>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5 text-left"
                onClick={openDetails}
              >
                <Settings2 className="size-4 shrink-0 text-text-tertiary" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-text">{t.detailSettings}</span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-text-tertiary">{detailSummary}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-text-tertiary" aria-hidden="true" />
              </button>
            </div>
          </PanelBody>
        </section>
      </div>
    </Panel>
    <AppDialog open={Boolean(report)} title={t.result} icon={<ShieldCheck className="size-4 text-accent" />} className="w-[min(46rem,92vw)]" onClose={() => setReport(null)}>
      {report ? <div className="grid gap-4 p-5">
        <div className={report.passed ? "rounded-xl bg-success-subtle p-4 font-bold text-success" : "rounded-xl bg-danger-subtle p-4 font-bold text-danger"}>{report.passed ? t.passed : t.failed}</div>
        <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          {[[t.sourceRows, report.source_rows], [t.targetRows, report.target_rows], [t.missing, report.missing_keys], [t.extra, report.extra_keys], [t.mismatch, report.mismatched_rows], [t.sourceDuplicates, report.duplicate_source_keys], [t.targetDuplicates, report.duplicate_target_keys]].map(([label, value]) => <div key={String(label)} className="rounded-lg border border-border p-3"><dt className="text-xs text-text-tertiary">{label}</dt><dd className="mt-1 font-bold tabular-nums">{value}</dd></div>)}
        </dl>
        {report.samples.length ? <pre className="max-h-60 overflow-auto rounded-xl bg-workspace p-4 text-xs text-white">{report.samples.join("\n")}</pre> : null}
      </div> : null}
    </AppDialog>
    <AppDialog
      open={detailOpen}
      title={t.detailSettings}
      icon={<Settings2 className="size-4 text-accent" aria-hidden="true" />}
      className="w-[min(28rem,92vw)]"
      minWidth={360}
      minHeight={280}
      onClose={() => setDetailOpen(false)}
      footer={
        <>
          <Button variant="secondary" onClick={() => setDetailOpen(false)}>{messages.common.cancel}</Button>
          <Button variant="primary" onClick={applyDetails}>{messages.common.save}</Button>
        </>
      }
    >
      <div className="grid gap-3 p-4">
        <p className="text-[11px] leading-5 text-text-tertiary">{t.detailHint}</p>
        <CheckOption label={t.compareRows} hint={t.compareRowsHint} checked={draftRowCount} onChange={setDraftRowCount} />
        <CheckOption label={t.compareSchema} hint={t.compareSchemaHint} checked={draftSchema} onChange={setDraftSchema} />
      </div>
    </AppDialog>
    <AppDialog
      open={registerOpen}
      title={t.registerChip}
      icon={<BookmarkPlus className="size-4 text-accent" aria-hidden="true" />}
      className="w-[min(22rem,92vw)]"
      minWidth={320}
      minHeight={220}
      onClose={() => setRegisterOpen(false)}
      footer={
        <>
          <Button variant="secondary" onClick={() => setRegisterOpen(false)}>{messages.common.cancel}</Button>
          <Button variant="primary" disabled={!registerName.trim() || !canRegister} onClick={() => void registerChip()}>
            {busy ? messages.common.saving : t.registerChip}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 p-4">
        <p className="text-[11px] leading-5 text-text-tertiary">{t.registerHint}</p>
        <FormField label={messages.workspace.chipName}>
          <input className="field-control" value={registerName} autoFocus onChange={(event) => setRegisterName(event.target.value)} />
        </FormField>
      </div>
    </AppDialog>
  </PageShell>;
}

function writeModeLabel(mode: string, messages: ReturnType<typeof useLanguage>["messages"]): string {
  if (mode === "append") return messages.load.append;
  if (mode === "replace" || mode === "truncate") return messages.load.truncate;
  if (mode === "upsert") return messages.load.upsert;
  if (mode === "recreate") return messages.load.recreate;
  return mode;
}

function LoadTargetPane({ slot }: { slot: ChipInputSlotResponse | null }) {
  const { messages } = useLanguage();
  const t = messages.validation;
  const mode = slot?.write_mode?.trim() ?? "";
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-surface">
      <PaneHeader title={t.target} />
      <div className="scroll-pane min-h-0 flex-1 overflow-y-auto bg-surface p-3">
        <div className="rounded-xl border border-warning/30 bg-warning-subtle/40 p-3">
          <div className="flex items-center gap-2">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-warning-subtle text-warning">
              <FileOutput className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-text">{slot?.source_chip_name || t.loadChip}</p>
              <p className="mt-0.5 truncate text-[11px] text-text-tertiary">{t.loadChip}</p>
            </div>
          </div>
          <dl className="mt-3 grid gap-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-text-tertiary">{t.loadDestination}</dt>
              <dd className="min-w-0 truncate font-medium text-text">{slot?.destination || "—"}</dd>
            </div>
            {mode ? (
              <div className="flex items-center justify-between gap-2">
                <dt className="text-text-tertiary">{messages.load.writeMode}</dt>
                <dd className="font-medium text-text">{writeModeLabel(mode, messages)}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      </div>
    </section>
  );
}

function CheckOption({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-surface px-3 py-2.5">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="block text-sm text-text">{label}</span>
        <span className="mt-0.5 block text-[11px] leading-4 text-text-tertiary">{hint}</span>
      </span>
    </label>
  );
}

function DatasetPicker({ title, datasets, value, onChange, kindLabels, disabled = false }: {
  title: string;
  datasets: Dataset[];
  value: string;
  onChange: (id: string) => void;
  kindLabels: Record<string, string>;
  disabled?: boolean;
}) {
  const { messages } = useLanguage();
  const [expanded, setExpanded] = useState<Set<(typeof KIND_ORDER)[number]>>(() => new Set());
  useEffect(() => {
    const selected = datasets.find((item) => item.id === value);
    if (!selected) return;
    const kind = selected.kind as (typeof KIND_ORDER)[number];
    if (!KIND_ORDER.includes(kind)) return;
    setExpanded((current) => {
      if (current.has(kind)) return current;
      const next = new Set(current);
      next.add(kind);
      return next;
    });
  }, [datasets, value]);
  const groups = KIND_ORDER.map((kind) => ({ kind, items: datasets.filter((item) => item.kind === kind) }));
  return <section className="flex h-full min-h-0 flex-col overflow-hidden bg-surface">
    <PaneHeader title={title} meta={messages.common.count(datasets.length)} />
    <div className="scroll-pane min-h-0 flex-1 overflow-y-auto bg-surface p-2">
      <div className="space-y-2">
        {groups.map(({ kind, items }) => {
          const appearance = KIND_APPEARANCE[kind];
          const KindIcon = appearance.icon;
          const open = expanded.has(kind);
          return <section key={kind} className="overflow-hidden rounded-lg border border-border bg-surface">
            <button type="button" aria-expanded={open} className={cn("flex w-full items-center gap-2 px-3 py-2 text-left", open && "border-b", appearance.header)} onClick={() => setExpanded((current) => { const next = new Set(current); if (open) next.delete(kind); else next.add(kind); return next; })}>
              <KindIcon className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 text-sm font-bold">{kindLabels[kind]}</span>
              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums", appearance.count)}>{items.length}</span>
              <ChevronRight className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")} aria-hidden="true" />
            </button>
            {open && items.length === 0 ? <p className="px-3 py-3 text-center text-xs text-text-tertiary">{messages.transform.noMatchingFiles}</p> : null}
            {open && items.map((dataset) => <button key={dataset.id} type="button" disabled={disabled} className={cn("flex w-full min-w-0 items-start gap-2 border-b border-border px-3 py-2.5 text-left last:border-b-0 disabled:cursor-default", selectableClass(value === dataset.id))} onClick={() => onChange(dataset.id)}>
              <FileSpreadsheet className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block break-all text-[13px] font-medium leading-4">{dataset.filename}</span>
                <span className="mt-0.5 block truncate text-[11px] text-text-tertiary">{dataset.origin?.connection_name ? `${dataset.origin.connection_name} · ${dataset.origin.table_name}` : dataset.row_count != null ? messages.common.rows(dataset.row_count) : dataset.source_chip_id ? dataset.source_chip_id.slice(0, 8) : dataset.id.slice(0, 8)}</span>
              </span>
            </button>)}
          </section>;
        })}
      </div>
    </div>
  </section>;
}
