import { FileSpreadsheet, GitMerge, Layers } from "lucide-react";
import { ColumnChipPicker } from "@/components/transform/TransformEditorParts";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { selectableClass } from "@/lib/selectable";
import type { CombineDraft } from "@/lib/transformEditor";
import type { Messages } from "@/i18n/ko";
import type { Dataset, DatasetColumn } from "@/types/dataset";

export function CombineSetup({
  messages,
  draft,
  datasetId,
  datasets,
  leftColumns,
  commonJoinKeys,
  onChange,
}: {
  messages: Messages;
  draft: CombineDraft;
  datasetId?: string;
  datasets: Dataset[];
  leftColumns: DatasetColumn[];
  commonJoinKeys: DatasetColumn[];
  onChange: (draft: CombineDraft) => void;
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
