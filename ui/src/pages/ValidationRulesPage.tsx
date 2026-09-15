import { useEffect, useMemo, useState } from "react";
import { Info, Pencil, Plus, Trash2 } from "lucide-react";
import { PaginationBar } from "@/components/PaginationBar";
import { EmptyState } from "@/components/DataGrid";
import { NavIcon } from "@/components/ui/nav-icons";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { usePagination } from "@/lib/pagination";
import { Button } from "@/components/ui/button";
import { ColumnChips } from "@/components/ColumnChips";
import { FormField } from "@/components/ui/form-field";
import { Select } from "@/components/ui/select";
import { AppDialog } from "@/components/AppDialog";
import { showConfirm, toastError, toastSuccess } from "@/lib/notifications";
import { useLanguage } from "@/i18n/LanguageProvider";
import { datasetApi } from "@/services/transform/datasetApi";
import { validationApi, type SaveValidationRule, type ValidationRule } from "@/services/validation/validationApi";
import type { Dataset } from "@/types/dataset";

const EMPTY: SaveValidationRule = {
  name: "",
  description: "",
  keys: [],
  columns: [],
  compare_row_count: true,
  compare_schema: true,
  active: true,
};

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function toggleList(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function ValidationRulesPage() {
  const { messages } = useLanguage();
  const t = messages.validation;
  const [rules, setRules] = useState<ValidationRule[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [editing, setEditing] = useState<ValidationRule | null | undefined>();
  const [draft, setDraft] = useState(EMPTY);
  const [sampleId, setSampleId] = useState("");
  const [sampleColumns, setSampleColumns] = useState<string[]>([]);
  const [sampleBusy, setSampleBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const paging = usePagination(rules);

  async function load() {
    try {
      setRules((await validationApi.listRules()).rules);
    } catch (error) {
      toastError(t.loadError, error);
    }
  }

  useEffect(() => {
    void load();
    void datasetApi.list()
      .then((result) => setDatasets(result.datasets.filter((item) => item.available)))
      .catch(() => setDatasets([]));
  }, []);

  function open(rule?: ValidationRule) {
    setEditing(rule ?? null);
    setDraft(rule
      ? {
          name: rule.name,
          description: rule.description,
          keys: rule.keys,
          columns: rule.columns,
          compare_row_count: rule.compare_row_count,
          compare_schema: rule.compare_schema,
          active: rule.active,
        }
      : EMPTY);
    setSampleId("");
    setSampleColumns([]);
  }

  async function pickSample(id: string) {
    setSampleId(id);
    if (!id) {
      setSampleColumns([]);
      return;
    }
    const found = datasets.find((item) => item.id === id);
    if (found?.columns.length) {
      setSampleColumns(found.columns.map((column) => column.name));
      return;
    }
    setSampleBusy(true);
    try {
      const inspected = await datasetApi.inspect(id, 100, true);
      const columns = inspected.dataset.columns.map((column) => column.name);
      setSampleColumns(columns);
      setDatasets((current) => current.map((item) => (
        item.id === id ? { ...item, columns: inspected.dataset.columns } : item
      )));
    } catch (error) {
      toastError(t.sampleColumnsError, error);
      setSampleColumns([]);
    } finally {
      setSampleBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      if (editing) await validationApi.updateRule(editing.id, draft);
      else await validationApi.createRule(draft);
      toastSuccess(t.ruleSaved);
      setEditing(undefined);
      await load();
    } catch (error) {
      toastError(t.saveError, error);
    } finally {
      setBusy(false);
    }
  }

  async function remove(rule: ValidationRule) {
    if (!await showConfirm(t.deleteRule, t.deleteRuleMessage)) return;
    try {
      await validationApi.deleteRule(rule.id);
      toastSuccess(t.ruleDeleted);
      await load();
    } catch (error) {
      toastError(t.deleteRuleError, error);
    }
  }

  const keyChoices = unique([...sampleColumns, ...draft.keys]);
  const columnChoices = unique([...sampleColumns, ...draft.columns]);
  const previewChecks = [
    draft.compare_row_count ? t.compareRows : null,
    draft.compare_schema ? t.compareSchema : null,
  ].filter((item): item is string => Boolean(item)).join(" · ");
  const canSave = Boolean(draft.name.trim() && draft.keys.length && !busy);
  const sampleOptions = useMemo(
    () => datasets.map((item) => ({ value: item.id, label: item.filename })),
    [datasets],
  );

  return (
    <PageShell>
      <PageHeader
        title={t.rulesTitle}
        description={t.rulesDescription}
        iconName="validationRules"
        actions={<Button variant="primary" onClick={() => open()}><Plus className="size-4" />{t.newRule}</Button>}
      />
      <Panel>
        <PanelHeader title={t.rules} description={t.rulesHint} />
        <PanelBody className="p-0">
          {rules.length === 0 ? (
            <EmptyState
              className="min-h-[calc(100vh-18rem)]"
              icon={<NavIcon name="validationRules" />}
              title={t.noRules}
              hint={t.noRulesHint}
            />
          ) : (
            <div className="divide-y divide-border">
              {paging.items.map((rule) => (
                <div key={rule.id} className="grid grid-cols-[1fr_auto] items-center gap-4 px-5 py-4 hover:bg-subtle/35">
                  <div>
                    <div className="flex items-center gap-2">
                      <strong className="text-sm text-text">{rule.name}</strong>
                      <span className="rounded-full bg-subtle px-2 py-0.5 text-[10px] text-text-tertiary">v{rule.revision}</span>
                      {!rule.active ? <span className="text-xs text-warning">{t.inactive}</span> : null}
                    </div>
                    <p className="mt-1 text-xs text-text-secondary">{rule.description || t.noDescription}</p>
                    <p className="mt-2 font-mono text-[11px] text-text-tertiary">
                      {t.keys}: {rule.keys.join(", ")} · {t.columns}: {rule.columns.join(", ") || t.allCommonColumns}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button variant="quiet" onClick={() => open(rule)}><Pencil className="size-3.5" />{messages.common.edit}</Button>
                    <Button variant="quiet" onClick={() => void remove(rule)}><Trash2 className="size-3.5" />{messages.common.delete}</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </PanelBody>
        <PaginationBar
          page={paging.page}
          pageCount={paging.pageCount}
          pageSize={paging.pageSize}
          total={paging.total}
          start={paging.start}
          end={paging.end}
          onPageChange={paging.setPage}
          onPageSizeChange={paging.setPageSize}
        />
      </Panel>
      <AppDialog
        open={editing !== undefined}
        title={editing ? t.editRule : t.newRule}
        onClose={() => setEditing(undefined)}
        className="flex max-h-[min(88vh,56rem)] w-[min(52rem,94vw)]"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(undefined)}>{messages.common.cancel}</Button>
            <Button variant="primary" disabled={!canSave} onClick={() => void save()}>{messages.common.save}</Button>
          </>
        }
      >
        <div className="scroll-pane min-h-0 flex-1 overflow-y-auto p-5">
          <div className="grid gap-5">
            <section className="rounded-xl border border-border bg-subtle/40 p-4">
              <div className="flex items-start gap-2">
                <Info className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
                <div className="grid gap-1.5 text-xs leading-5 text-text-secondary">
                  <p className="font-semibold text-text">{t.ruleGuideTitle}</p>
                  <p>{t.ruleGuide}</p>
                  <p>{t.ruleGuideKeys}</p>
                  <p>{t.ruleGuideColumns}</p>
                </div>
              </div>
            </section>
            <FormField label={t.ruleName} hint={t.ruleNameHint}>
              <input className="field-control" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </FormField>
            <FormField label={t.ruleDescription} hint={t.ruleDescriptionHint}>
              <textarea className="field-control min-h-20" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
            </FormField>
            <FormField label={t.sampleFile} hint={t.sampleFileHint}>
              <Select
                value={sampleId}
                options={sampleOptions}
                placeholder={datasets.length ? t.sampleFileNone : t.noDatasets}
                disabled={!datasets.length}
                onChange={(id) => void pickSample(id)}
              />
            </FormField>
            <FormField label={t.keys} hint={t.ruleKeysHint}>
              <ColumnChips
                choices={keyChoices}
                selected={draft.keys}
                empty={sampleBusy ? messages.common.loading : t.noColumnChoices}
                busy={sampleBusy}
                onToggle={(name) => setDraft({
                  ...draft,
                  keys: toggleList(draft.keys, name),
                  columns: draft.columns.filter((column) => column !== name),
                })}
              />
            </FormField>
            <FormField label={t.columns} hint={t.ruleColumnsHint}>
              <ColumnChips
                choices={columnChoices}
                selected={draft.columns}
                disabledNames={draft.keys}
                empty={sampleBusy ? messages.common.loading : t.noColumnChoices}
                busy={sampleBusy}
                onToggle={(name) => setDraft({ ...draft, columns: toggleList(draft.columns, name) })}
              />
            </FormField>
            <div className="grid gap-2">
              <CheckOption
                label={t.compareRows}
                hint={t.compareRowsHint}
                checked={draft.compare_row_count}
                onChange={(compare_row_count) => setDraft({ ...draft, compare_row_count })}
              />
              <CheckOption
                label={t.compareSchema}
                hint={t.compareSchemaHint}
                checked={draft.compare_schema}
                onChange={(compare_schema) => setDraft({ ...draft, compare_schema })}
              />
              <CheckOption
                label={t.active}
                hint={t.activeHint}
                checked={draft.active}
                onChange={(active) => setDraft({ ...draft, active })}
              />
            </div>
            <section className="rounded-xl border border-border bg-raised p-4">
              <h3 className="text-xs font-semibold text-text">{t.rulePreview}</h3>
              <p className="mt-2 text-xs leading-5 text-text-secondary">
                {draft.keys.length
                  ? t.rulePreviewBody(
                      draft.keys.join(", "),
                      draft.columns.join(", ") || t.allCommonColumns,
                      previewChecks || t.noExtraChecks,
                    )
                  : t.rulePreviewNeedKeys}
              </p>
              {!draft.active ? <p className="mt-2 text-xs text-warning">{t.rulePreviewInactive}</p> : null}
            </section>
          </div>
        </div>
      </AppDialog>
    </PageShell>
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
