import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Play, Save, ShieldCheck } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Select } from "@/components/ui/select";
import { AppDialog } from "@/components/AppDialog";
import { datasetApi } from "@/services/transform/datasetApi";
import { validationApi, type ValidationReport, type ValidationRule } from "@/services/validation/validationApi";
import { chipApi } from "@/services/chips/chipApi";
import { toastError, toastSuccess } from "@/lib/notifications";
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
        const [chip, slot] = await Promise.all([
          chipApi.get(editorChipId),
          chipApi.getInputSlot(workspaceId, editorChipId),
        ]);
        if (cancelled) return;
        const config = chip.config;
        const savedRuleId = typeof config.validation_rule_id === "string" ? config.validation_rule_id : "";
        const savedRule = ruleResult.rules.find((rule) => rule.id === savedRuleId);
        setRuleId(savedRuleId);
        setSourceId(typeof config.source_data_file_id === "string" ? config.source_data_file_id : "");
        setKeys(savedRule ? savedRule.keys.join(", ") : Array.isArray(config.keys) ? config.keys.filter((v): v is string => typeof v === "string").join(", ") : "");
        setColumns(savedRule ? savedRule.columns.join(", ") : Array.isArray(config.columns) ? config.columns.filter((v): v is string => typeof v === "string").join(", ") : "");
        setTargetId(slot.mode === "materialized" ? slot.dataset_id ?? "" : "");
      } catch (error) {
        toastError(t.loadError, error);
      }
    })();
    return () => { cancelled = true; };
  }, [editorChipId, t.loadError, workspaceId]);
  const options = useMemo(() => datasets.map((item) => ({ value: item.id, label: item.filename })), [datasets]);
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
    } catch (error) {
      toastError(t.saveError, error);
    } finally {
      setBusy(false);
    }
  }
  return <PageShell>
    <PageHeader iconName="jobs" eyebrow={t.eyebrow} title={t.title} description={t.description}
      actions={editingChip ? <Button variant="quiet" onClick={() => navigate(`/workspace/${workspaceId}`)}><ArrowLeft className="size-3.5" />{t.backToWorkspace}</Button> : undefined} />
    <Panel tall>
      <PanelHeader title={t.settings} description={t.hint} />
      <PanelBody className="scroll-pane min-h-0 flex-1 overflow-auto">
        <div className="mx-auto grid max-w-3xl gap-5 rounded-2xl border border-border bg-surface p-6 shadow-sm">
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label={t.source}><Select value={sourceId} options={options} placeholder={t.pickDataset} onChange={setSourceId} /></FormField>
            <FormField label={t.target} hint={editingChip ? t.targetFromCanvas : undefined}><Select value={targetId} options={options} placeholder={editingChip ? t.waitingForInput : t.pickDataset} disabled={editingChip} onChange={setTargetId} /></FormField>
          </div>
          <FormField label={t.rule}><Select value={ruleId} options={rules.map((rule) => ({ value: rule.id, label: `${rule.name} · v${rule.revision}` }))} placeholder={t.customRule} onChange={(id) => { setRuleId(id); const rule = rules.find((item) => item.id === id); if (rule) { setKeys(rule.keys.join(", ")); setColumns(rule.columns.join(", ")); } }} /></FormField>
          <FormField label={t.keys} hint={ruleId ? t.ruleOverrides : t.keysHint}><input disabled={Boolean(ruleId)} className="field-control technical" value={keys} onChange={(e) => setKeys(e.target.value)} /></FormField>
          <FormField label={t.columns} hint={ruleId ? t.ruleOverrides : t.columnsHint}><input disabled={Boolean(ruleId)} className="field-control technical" value={columns} onChange={(e) => setColumns(e.target.value)} /></FormField>
          <div className="flex justify-end gap-2">
            {editingChip ? <Button disabled={busy || !sourceId || (!ruleId && !keys.trim())} onClick={() => void save()}><Save className="size-3.5" />{messages.common.save}</Button> : null}
            <Button variant="primary" disabled={busy || !sourceId || !targetId || sourceId === targetId || (!ruleId && !keys.trim())} onClick={() => void run()}><Play className="size-3.5" />{busy ? messages.common.running : messages.common.run}</Button>
          </div>
        </div>
      </PanelBody>
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
