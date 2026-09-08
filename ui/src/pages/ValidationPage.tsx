import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronRight, FileSpreadsheet, Play, Save, ShieldCheck } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { PaneHeader } from "@/components/ui/pane-header";
import { Button } from "@/components/ui/button";
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
import type { Dataset } from "@/types/dataset";

export function ValidationPage() {
  const navigate = useNavigate();
  const { workspaceId, editorChipId } = useParams();
  const editingChip = Boolean(workspaceId && editorChipId);
  const { messages } = useLanguage();
  const t = messages.validation;
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [rules, setRules] = useState<ValidationRule[]>([]);
  const [ruleId, setRuleId] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [keys, setKeys] = useState("");
  const [columns, setColumns] = useState("");
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
        if (!editorChipId || !workspaceId) return;
        const [chip, slot, workspace, workspaceChips] = await Promise.all([
          chipApi.get(editorChipId),
          chipApi.getInputSlot(workspaceId, editorChipId),
          workspaceApi.get(workspaceId),
          chipApi.list(workspaceId),
        ]);
        if (cancelled) return;
        const config = chip.config;
        const savedRuleId = typeof config.validation_rule_id === "string" ? config.validation_rule_id : "";
        const savedRule = ruleResult.rules.find((rule) => rule.id === savedRuleId);
        setRuleId(savedRuleId);
        const incoming = (workspace.edges ?? []).filter((edge) => edge.kind === "data" && edge.to_chip_id === editorChipId);
        const sourceEdge = incoming.find((edge) => edge.to_port === "source") ?? incoming[0];
        const targetEdge = incoming.find((edge) => edge.to_port === "target") ?? incoming[1];
        const connectedDatasetId = (edge: typeof sourceEdge) => edge
          ? workspaceChips.chips.find((item) => item.id === edge.from_chip_id)?.output?.dataset_id ?? ""
          : "";
        setSourceId(connectedDatasetId(sourceEdge) || (typeof config.source_data_file_id === "string" ? config.source_data_file_id : ""));
        setKeys(savedRule ? savedRule.keys.join(", ") : Array.isArray(config.keys) ? config.keys.filter((v): v is string => typeof v === "string").join(", ") : "");
        setColumns(savedRule ? savedRule.columns.join(", ") : Array.isArray(config.columns) ? config.columns.filter((v): v is string => typeof v === "string").join(", ") : "");
        const slotDataset = datasetFromSlot(slot);
        if (slotDataset) {
          setDatasets((current) => current.some((item) => item.id === slotDataset.id) ? current : [...current, slotDataset]);
          setTargetId(connectedDatasetId(targetEdge) || slotDataset.id);
        } else {
          setTargetId("");
        }
      } catch (error) {
        toastError(t.loadError, error);
      }
    })();
    return () => { cancelled = true; };
  }, [editorChipId, t.loadError, workspaceId]);
  const kindLabels = useMemo<Record<string, string>>(() => ({
    upload: messages.transform.kindUpload,
    database: messages.transform.kindDatabase,
    api: messages.transform.kindApi,
    transform: messages.transform.kindTransform,
  }), [messages.transform]);
  async function run() {
    setBusy(true);
    try {
      const response = await validationApi.run({
        source_data_file_id: sourceId, target_data_file_id: targetId,
        validation_rule_id: ruleId || undefined,
        keys: keys.split(",").map((v) => v.trim()).filter(Boolean),
        columns: columns.split(",").map((v) => v.trim()).filter(Boolean),
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
          source_data_file_id: sourceId,
          keys: keys.split(",").map((v) => v.trim()).filter(Boolean),
          columns: columns.split(",").map((v) => v.trim()).filter(Boolean),
          compare_row_count: true,
          compare_schema: true,
        },
      });
      toastSuccess(t.saved);
      navigate(`/workspace/${workspaceId}`);
    } catch (error) {
      toastError(t.saveError, error);
    } finally {
      setBusy(false);
    }
  }
  return <PageShell>
    <PageHeader iconName="jobs" eyebrow={t.eyebrow} title={t.title} description={t.description}
      actions={editingChip ? <Button variant="quiet" onClick={() => navigate(`/workspace/${workspaceId}`)}><ArrowLeft className="size-3.5" />{t.backToWorkspace}</Button> : undefined} />
    <Panel tall className="overflow-hidden">
      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-2 overflow-hidden">
        <aside className="grid h-full min-h-0 min-w-0 grid-cols-2 overflow-hidden border-r border-border">
          <div className="min-h-0 min-w-0 overflow-hidden border-r border-border">
            <DatasetPicker title={t.source} datasets={datasets} value={sourceId} onChange={setSourceId} kindLabels={kindLabels} />
          </div>
          <div className="min-h-0 min-w-0 overflow-hidden">
            <DatasetPicker title={t.target} datasets={datasets} value={targetId} onChange={setTargetId} kindLabels={kindLabels} disabled={editingChip} hint={editingChip ? t.targetFromCanvas : undefined} />
          </div>
        </aside>
        <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
          <PanelHeader
            title={t.settings}
            description={t.hint}
            actions={
              <Button
                variant="primary"
                disabled={busy || !sourceId || !targetId || sourceId === targetId || (!ruleId && !keys.trim())}
                onClick={() => void run()}
              >
                <Play className="size-3.5" />
                {busy ? messages.common.running : messages.common.run}
              </Button>
            }
          />
          <PanelBody className="scroll-pane min-h-0 flex-1 overflow-auto bg-raised">
            <div className="mx-auto grid max-w-3xl gap-5 rounded-2xl border border-border bg-surface p-6 shadow-sm">
          <FormField label={t.rule}><Select value={ruleId} options={rules.map((rule) => ({ value: rule.id, label: `${rule.name} · v${rule.revision}` }))} placeholder={t.customRule} onChange={(id) => { setRuleId(id); const rule = rules.find((item) => item.id === id); if (rule) { setKeys(rule.keys.join(", ")); setColumns(rule.columns.join(", ")); } }} /></FormField>
          <FormField label={t.keys} hint={ruleId ? t.ruleOverrides : t.keysHint}><input disabled={Boolean(ruleId)} className="field-control technical" value={keys} onChange={(e) => setKeys(e.target.value)} /></FormField>
          <FormField label={t.columns} hint={ruleId ? t.ruleOverrides : t.columnsHint}><input disabled={Boolean(ruleId)} className="field-control technical" value={columns} onChange={(e) => setColumns(e.target.value)} /></FormField>
          <div className="flex justify-end gap-2">
            {editingChip ? <Button disabled={busy || (!ruleId && !keys.trim())} onClick={() => void save()}><Save className="size-3.5" />{messages.common.save}</Button> : null}
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
