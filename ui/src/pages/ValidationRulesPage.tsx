import { useEffect, useState } from "react";
import { Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { AppDialog } from "@/components/AppDialog";
import { showConfirm, toastError, toastSuccess } from "@/lib/notifications";
import { useLanguage } from "@/i18n/LanguageProvider";
import { validationApi, type SaveValidationRule, type ValidationRule } from "@/services/validation/validationApi";

const EMPTY: SaveValidationRule = { name: "", description: "", keys: [], columns: [], compare_row_count: true, compare_schema: true, active: true };

export function ValidationRulesPage() {
  const { messages } = useLanguage(); const t = messages.validation;
  const [rules, setRules] = useState<ValidationRule[]>([]); const [editing, setEditing] = useState<ValidationRule | null | undefined>();
  const [draft, setDraft] = useState(EMPTY); const [busy, setBusy] = useState(false);
  async function load() { try { setRules((await validationApi.listRules()).rules); } catch (e) { toastError(t.loadError, e); } }
  useEffect(() => { void load(); }, []);
  function open(rule?: ValidationRule) { setEditing(rule ?? null); setDraft(rule ? { name: rule.name, description: rule.description, keys: rule.keys, columns: rule.columns, compare_row_count: rule.compare_row_count, compare_schema: rule.compare_schema, active: rule.active } : EMPTY); }
  async function save() { setBusy(true); try { if (editing) await validationApi.updateRule(editing.id, draft); else await validationApi.createRule(draft); toastSuccess(t.ruleSaved); setEditing(undefined); await load(); } catch (e) { toastError(t.saveError, e); } finally { setBusy(false); } }
  async function remove(rule: ValidationRule) { if (!await showConfirm(t.deleteRule, t.deleteRuleMessage)) return; try { await validationApi.deleteRule(rule.id); toastSuccess(t.ruleDeleted); await load(); } catch (e) { toastError(t.deleteRuleError, e); } }
  return <PageShell><PageHeader title={t.rulesTitle} description={t.rulesDescription} icon={<ShieldCheck className="size-[22px]" />} actions={<Button variant="primary" onClick={() => open()}><Plus className="size-4" />{t.newRule}</Button>} />
    <Panel tall><PanelHeader title={t.rules} description={t.rulesHint} /><PanelBody className="scroll-pane min-h-0 flex-1 overflow-auto p-0">
      {rules.length === 0 ? <p className="p-8 text-center text-sm text-text-tertiary">{t.noRules}</p> : <div className="divide-y divide-border">{rules.map((rule) => <div key={rule.id} className="grid grid-cols-[1fr_auto] items-center gap-4 px-5 py-4 hover:bg-subtle/35"><div><div className="flex items-center gap-2"><strong className="text-sm text-text">{rule.name}</strong><span className="rounded-full bg-subtle px-2 py-0.5 text-[10px] text-text-tertiary">v{rule.revision}</span>{!rule.active ? <span className="text-xs text-warning">{t.inactive}</span> : null}</div><p className="mt-1 text-xs text-text-secondary">{rule.description || t.noDescription}</p><p className="mt-2 font-mono text-[11px] text-text-tertiary">{t.keys}: {rule.keys.join(", ")} · {t.columns}: {rule.columns.join(", ") || t.allCommonColumns}</p></div><div className="flex gap-1"><Button variant="quiet" onClick={() => open(rule)}><Pencil className="size-3.5" />{messages.common.edit}</Button><Button variant="quiet" onClick={() => void remove(rule)}><Trash2 className="size-3.5" />{messages.common.delete}</Button></div></div>)}</div>}
    </PanelBody></Panel>
    <AppDialog open={editing !== undefined} title={editing ? t.editRule : t.newRule} onClose={() => setEditing(undefined)} className="w-[min(42rem,94vw)]"><div className="grid gap-4 p-5"><FormField label={t.ruleName}><input className="field-control" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></FormField><FormField label={t.ruleDescription}><textarea className="field-control min-h-20" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></FormField><FormField label={t.keys} hint={t.keysHint}><input className="field-control technical" value={draft.keys.join(", ")} onChange={(e) => setDraft({ ...draft, keys: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })} /></FormField><FormField label={t.columns} hint={t.columnsHint}><input className="field-control technical" value={draft.columns.join(", ")} onChange={(e) => setDraft({ ...draft, columns: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })} /></FormField><div className="flex flex-wrap gap-5 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={draft.compare_row_count} onChange={(e) => setDraft({ ...draft, compare_row_count: e.target.checked })} />{t.compareRows}</label><label className="flex items-center gap-2"><input type="checkbox" checked={draft.compare_schema} onChange={(e) => setDraft({ ...draft, compare_schema: e.target.checked })} />{t.compareSchema}</label><label className="flex items-center gap-2"><input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />{t.active}</label></div><div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setEditing(undefined)}>{messages.common.cancel}</Button><Button variant="primary" disabled={busy || !draft.name.trim() || draft.keys.length === 0} onClick={() => void save()}>{messages.common.save}</Button></div></div></AppDialog>
  </PageShell>;
}
