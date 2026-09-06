import { useEffect, useMemo, useState } from "react";
import { Eye, ShieldCheck } from "lucide-react";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/AppDialog";
import { useLanguage } from "@/i18n/LanguageProvider";
import { toastError } from "@/lib/notifications";
import { validationApi, type ValidationResult, type ValidationRule } from "@/services/validation/validationApi";

export function ValidationResultsPage() {
  const { messages } = useLanguage(); const t = messages.validation;
  const [results, setResults] = useState<ValidationResult[]>([]); const [rules, setRules] = useState<ValidationRule[]>([]); const [selected, setSelected] = useState<ValidationResult | null>(null);
  useEffect(() => { void Promise.all([validationApi.listResults(), validationApi.listRules()]).then(([a, b]) => { setResults(a.results); setRules(b.rules); }).catch((e) => toastError(t.loadError, e)); }, []);
  const names = useMemo(() => new Map(rules.map((r) => [r.id, r.name])), [rules]);
  return <PageShell><PageHeader title={t.resultsTitle} description={t.resultsDescription} icon={<ShieldCheck className="size-[22px]" />} /><Panel tall><PanelHeader title={t.results} description={t.resultsHint} /><PanelBody className="scroll-pane min-h-0 flex-1 overflow-auto p-0">{results.length === 0 ? <p className="p-8 text-center text-sm text-text-tertiary">{t.noResults}</p> : <div className="divide-y divide-border">{results.map((result) => <div key={result.id} className="grid grid-cols-[8rem_1fr_repeat(4,5rem)_auto] items-center gap-3 px-5 py-3 text-xs"><span className={result.passed ? "font-bold text-success" : "font-bold text-danger"}>{result.passed ? t.passed : t.failed}</span><span className="truncate text-text">{result.validation_rule_id ? names.get(result.validation_rule_id) || t.deletedRule : t.customRule}</span><span>{t.sourceRows}<strong className="ml-1">{result.report.source_rows}</strong></span><span>{t.targetRows}<strong className="ml-1">{result.report.target_rows}</strong></span><span>{t.missing}<strong className="ml-1">{result.report.missing_keys}</strong></span><span>{t.mismatch}<strong className="ml-1">{result.report.mismatched_rows}</strong></span><Button variant="quiet" onClick={() => setSelected(result)}><Eye className="size-3.5" />{messages.common.view}</Button></div>)}</div>}</PanelBody></Panel>
    <AppDialog open={Boolean(selected)} title={t.result} onClose={() => setSelected(null)} className="w-[min(46rem,94vw)]">{selected ? <div className="grid gap-4 p-5"><div className={selected.passed ? "rounded-xl bg-success-subtle p-4 font-bold text-success" : "rounded-xl bg-danger-subtle p-4 font-bold text-danger"}>{selected.passed ? t.passed : t.failed}</div><dl className="grid grid-cols-2 gap-3 md:grid-cols-4">{[[t.sourceRows, selected.report.source_rows], [t.targetRows, selected.report.target_rows], [t.missing, selected.report.missing_keys], [t.extra, selected.report.extra_keys], [t.mismatch, selected.report.mismatched_rows], [t.sourceDuplicates, selected.report.duplicate_source_keys], [t.targetDuplicates, selected.report.duplicate_target_keys]].map(([label, value]) => <div key={String(label)} className="rounded-lg border border-border p-3"><dt className="text-xs text-text-tertiary">{label}</dt><dd className="mt-1 font-bold">{value}</dd></div>)}</dl>{selected.report.samples.length ? <pre className="max-h-64 overflow-auto rounded-xl bg-workspace p-4 text-xs text-white">{selected.report.samples.join("\n")}</pre> : null}</div> : null}</AppDialog>
  </PageShell>;
}
