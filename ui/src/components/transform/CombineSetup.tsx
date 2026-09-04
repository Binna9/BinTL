import { FileSpreadsheet, GitMerge, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { selectableClass } from "@/lib/selectable";
import type { CombineDraft } from "@/lib/transformEditor";
import type { Messages } from "@/i18n/ko";
import type { Dataset, DatasetColumn } from "@/types/dataset";

function ColumnChipPicker({
  columns,
  value,
  emptyLabel,
  onChange,
  minSelected = 1,
}: {
  columns: DatasetColumn[];
  value: string[];
  emptyLabel: string;
  onChange: (columns: string[]) => void;
  minSelected?: number;
}) {
  if (columns.length === 0) {
    return <p className="text-xs text-text-tertiary">{emptyLabel}</p>;
  }
  const kept = new Set(value);
  function toggle(name: string) {
    if (kept.has(name)) {
      if (kept.size <= minSelected) return;
      onChange(value.filter((column) => column !== name));
      return;
    }
    onChange([...value, name]);
  }
  return (
    <div className="scroll-pane -mx-0.5 overflow-x-auto px-0.5">
      <div className="flex flex-nowrap gap-1.5 pb-0.5">
        {columns.map((column) => {
          const active = kept.has(column.name);
          return (
            <button
              key={column.name}
              type="button"
              aria-pressed={active}
              onClick={() => toggle(column.name)}
              className={cn(
                "shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                active
                  ? "border-accent bg-accent-subtle text-accent"
                  : "border-border bg-raised text-text-tertiary hover:border-border hover:bg-subtle hover:text-text-secondary",
              )}
            >
              {column.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function CombineSetup({
  messages,
  draft,
  datasetId,
  datasets,
  leftColumns,
  commonJoinKeys,
  onChange,
  onDisable,
}: {
  messages: Messages;
  draft: CombineDraft;
  datasetId?: string;
  datasets: Dataset[];
  leftColumns: DatasetColumn[];
  commonJoinKeys: DatasetColumn[];
  onChange: (draft: CombineDraft) => void;
  onDisable?: () => void;
}) {
  const t = messages.transform;

  function toggleUnion(id: string) {
    const next = draft.unionDatasetIds.includes(id)
      ? draft.unionDatasetIds.filter((item) => item !== id)
      : [...draft.unionDatasetIds, id];
    onChange({ ...draft, unionDatasetIds: next });
  }

  return (
    <div className="scroll-pane min-h-0 flex-1 overflow-auto p-4">
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant={draft.mode === "join" ? "primary" : "quiet"}
            className="gap-2"
            onClick={() => onChange({ ...draft, mode: "join" })}
          >
            <GitMerge className="size-3.5" aria-hidden="true" />
            {t.combineModeJoin}
          </Button>
          <Button
            type="button"
            variant={draft.mode === "union" ? "primary" : "quiet"}
            className="gap-2"
            onClick={() => onChange({ ...draft, mode: "union" })}
          >
            <Layers className="size-3.5" aria-hidden="true" />
            {t.combineModeUnion}
          </Button>
          {onDisable ? (
            <Button type="button" variant="quiet" onClick={onDisable}>
              {t.combineDisable}
            </Button>
          ) : null}
        </div>

        {draft.mode === "join" ? (
          <>
            <FormField label={t.combineRight}>
              <Select
                value={draft.rightDatasetId ?? ""}
                placeholder={t.combinePickRight}
                options={datasets
                  .filter((item) => item.id !== datasetId && item.available)
                  .map((item) => ({ value: item.id, label: item.filename }))}
                onChange={(value) => onChange({ ...draft, rightDatasetId: value || undefined })}
              />
            </FormField>
            <FormField label={t.combineJoinKeys} hint={t.combineJoinKeysHint}>
              <ColumnChipPicker
                columns={commonJoinKeys.length > 0 ? commonJoinKeys : leftColumns}
                value={draft.joinKeys}
                emptyLabel={t.combineNoCommonKeys}
                onChange={(joinKeys) => onChange({ ...draft, joinKeys })}
              />
            </FormField>
            <FormField label={t.combineJoinHow}>
              <Select
                value={draft.joinHow}
                options={[
                  { value: "left", label: t.combineJoinLeft },
                  { value: "inner", label: t.combineJoinInner },
                ]}
                onChange={(value) =>
                  onChange({ ...draft, joinHow: value as CombineDraft["joinHow"] })
                }
              />
            </FormField>
          </>
        ) : (
          <FormField label={t.combineUnionExtra} hint={t.combineUnionHint}>
            <div className="space-y-1">
              {datasets
                .filter((item) => item.id !== datasetId && item.available)
                .map((item) => {
                  const active = draft.unionDatasetIds.includes(item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleUnion(item.id)}
                      className={cn(
                        "flex w-full min-w-0 items-start gap-2 border-b border-border px-3 py-2.5 text-left last:border-b-0",
                        selectableClass(active),
                      )}
                    >
                      <FileSpreadsheet
                        className="mt-0.5 size-3.5 shrink-0 text-text-tertiary"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                        {item.filename}
                      </span>
                    </button>
                  );
                })}
            </div>
          </FormField>
        )}
      </div>
    </div>
  );
}
