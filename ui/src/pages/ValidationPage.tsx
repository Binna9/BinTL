import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronRight, FileSpreadsheet, Play, Save, ShieldCheck } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { PaneHeader } from "@/components/ui/pane-header";
import { Button } from "@/components/ui/button";
import { ColumnChips } from "@/components/ColumnChips";
import { FormField } from "@/components/ui/form-field";
import { Select } from "@/components/ui/select";
import { AppDialog } from "@/components/AppDialog";
import { datasetApi } from "@/services/transform/datasetApi";
import { validationApi, type ValidationReport, type ValidationRule } from "@/services/validation/validationApi";
import { chipApi } from "@/services/chips/chipApi";
import { workspaceApi } from "@/services/workspace/workspaceApi";
import { toastError, toastSuccess } from "@/lib/notifications";
import { cn } from "@/lib/cn";
import { selectableClass } from "@/lib/selectable";
import { KIND_APPEARANCE, KIND_ORDER, datasetFromSlot } from "@/features/transform/transformEditorModel";
import { useLanguage } from "@/i18n/LanguageProvider";
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

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

function slotColumns(slot: ChipInputSlotResponse | null): string[] {
  if (!slot) return [];
  const dataset = slot.dataset as Dataset | undefined;
  return unique([
    ...(slot.columns?.map((column) => column.name) ?? []),
    ...(dataset?.columns?.map((column) => column.name) ?? []),
  ]);
}

export function ValidationPage() {
  const navigate = useNavigate();
  const { workspaceId, editorChipId } = useParams();
  const editingChip = Boolean(editorChipId);
  const canvasMode = Boolean(workspaceId && editorChipId);
  const { messages } = useLanguage();
  const t = messages.validation;
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [rules, setRules] = useState<ValidationRule[]>([]);
  const [ruleId, setRuleId] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [keys, setKeys] = useState<string[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [fileColumns, setFileColumns] = useState<string[]>([]);
  const [sourceSlot, setSourceSlot] = useState<ChipInputSlotResponse | null>(null);
  const [targetSlot, setTargetSlot] = useState<ChipInputSlotResponse | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [result, ruleResult] = await Promise.all([datasetApi.list(), validationApi.listRules()]);
        if (cancelled) return;
        setDatasets(result.datasets.filter((item) => item.available && (!workspaceId || item.workspace_id === workspaceId)));
        setRules(ruleResult.rules.filter((rule) => rule.active));
        if (!editorChipId) return;
        if (!workspaceId) {
          const chip = await chipApi.get(editorChipId);
          if (cancelled) return;
          const config = chip.config;
          const savedRuleId = typeof config.validation_rule_id === "string" ? config.validation_rule_id : "";
          const savedRule = ruleResult.rules.find((rule) => rule.id === savedRuleId);
          setRuleId(savedRuleId);
          setSourceId(typeof config.source_data_file_id === "string" ? config.source_data_file_id : "");
          setKeys(savedRule ? savedRule.keys : stringList(config.keys));
          setColumns(savedRule ? savedRule.columns : stringList(config.columns));
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
        const savedRuleId = typeof config.validation_rule_id === "string" ? config.validation_rule_id : "";
        const savedRule = ruleResult.rules.find((rule) => rule.id === savedRuleId);
        setRuleId(savedRuleId);
        setKeys(savedRule ? savedRule.keys : stringList(config.keys));
        setColumns(savedRule ? savedRule.columns : stringList(config.columns));
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
  const sourceFileId = storedFileId(sourceId);
  const targetFileId = storedFileId(targetId);
  const columnChoices = unique([...slotColumns(sourceSlot), ...slotColumns(targetSlot), ...fileColumns, ...keys, ...columns]);
  const canSave = Boolean((ruleId || keys.length) && !busy);
  const canRun = Boolean(sourceFileId && targetFileId && sourceFileId !== targetFileId && (ruleId || keys.length) && !busy);

  async function run() {
    if (!canRun) return;
    setBusy(true);
    try {
      const response = await validationApi.run({
        source_data_file_id: sourceFileId, target_data_file_id: targetFileId,
        validation_rule_id: ruleId || undefined,
        keys, columns,
      });
      setReport(response.report);
    } catch (error) { toastError(t.runError, error); } finally { setBusy(false); }
  }
  async function save() {
    if (!editorChipId) return;
    setBusy(true);
    try {
      await chipApi.update(editorChipId, {
        config: {
          validation_rule_id: ruleId || undefined,
          source_data_file_id: sourceFileId,
          keys, columns,
          compare_row_count: true,
          compare_schema: true,
        },
      });
      toastSuccess(t.saved);
      navigate(workspaceId ? `/workspace/${workspaceId}` : "/chips");
    } catch (error) {
      toastError(t.saveError, error);
    } finally {
      setBusy(false);
    }
  }
  return <PageShell>
    <PageHeader iconName="validation" eyebrow={t.eyebrow} title={t.title} description={t.description}
      actions={editingChip ? <Button variant="quiet" onClick={() => navigate(workspaceId ? `/workspace/${workspaceId}` : "/chips")}><ArrowLeft className="size-3.5" />{workspaceId ? t.backToWorkspace : messages.chips.backToChips}</Button> : undefined} />
    <Panel tall className="overflow-hidden">
      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-2 overflow-hidden">
        <aside className="grid h-full min-h-0 min-w-0 grid-cols-2 overflow-hidden border-r border-border">
          <div className="min-h-0 min-w-0 overflow-hidden border-r border-border">
            <DatasetPicker title={t.source} datasets={datasets} value={sourceId} onChange={setSourceId} kindLabels={kindLabels} disabled={sourceWired} hint={sourceWired ? t.sourceFromCanvas : undefined} />
          </div>
          <div className="min-h-0 min-w-0 overflow-hidden">
            <DatasetPicker title={t.target} datasets={datasets} value={targetId} onChange={setTargetId} kindLabels={kindLabels} disabled={targetWired} hint={targetWired ? t.targetFromCanvas : undefined} />
          </div>
        </aside>
        <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
          <PanelHeader
            title={t.settings}
            description={canvasMode ? t.canvasHint : t.hint}
            actions={
              <Button
                variant="primary"
                disabled={!canRun}
                onClick={() => void run()}
              >
                <Play className="size-3.5" />
                {busy ? messages.common.running : messages.common.run}
              </Button>
            }
          />
          <PanelBody className="scroll-pane min-h-0 flex-1 overflow-auto bg-raised">
            <div className="mx-auto grid max-w-3xl gap-5 rounded-2xl border border-border bg-surface p-6 shadow-sm">
          <FormField label={t.rule}><Select value={ruleId} options={rules.map((rule) => ({ value: rule.id, label: `${rule.name} · v${rule.revision}` }))} placeholder={t.customRule} onChange={(id) => { setRuleId(id); const rule = rules.find((item) => item.id === id); if (rule) { setKeys(rule.keys); setColumns(rule.columns); } }} /></FormField>
          <FormField label={t.keys} hint={ruleId ? t.ruleOverrides : canvasMode ? t.canvasKeysHint : t.keysHint}>
            <ColumnChips
              choices={columnChoices}
              selected={keys}
              empty={t.noConnectedColumns}
              disabled={Boolean(ruleId)}
              onToggle={(name) => setKeys((current) => {
                const next = toggleList(current, name);
                setColumns((cols) => cols.filter((column) => !next.includes(column)));
                return next;
              })}
            />
          </FormField>
          <FormField label={t.columns} hint={ruleId ? t.ruleOverrides : t.columnsHint}>
            <ColumnChips
              choices={columnChoices}
              selected={columns}
              disabledNames={keys}
              empty={t.noConnectedColumns}
              disabled={Boolean(ruleId)}
              onToggle={(name) => setColumns((current) => toggleList(current, name))}
            />
          </FormField>
          <div className="flex justify-end gap-2">
            {editingChip ? <Button disabled={!canSave} onClick={() => void save()}><Save className="size-3.5" />{messages.common.save}</Button> : null}
          </div>
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
  </PageShell>;
}

function DatasetPicker({ title, hint, datasets, value, onChange, kindLabels, disabled = false }: {
  title: string;
  hint?: string;
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
    <PaneHeader title={title} description={hint} meta={messages.common.count(datasets.length)} />
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
