import { useMemo, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { StepFields } from "@/components/transform/TransformEditorParts";
import { Button } from "@/components/ui/button";
import {
  emptyStep,
  resolveColumnsAtStep,
  STEP_OP_ICONS,
  STEP_OPS,
} from "@/features/transform/transformEditorModel";
import type { Messages } from "@/i18n/ko";
import { formatTransformStepSummary } from "@/lib/chipDetail";
import { cn } from "@/lib/cn";
import type { DatasetColumn } from "@/types/dataset";
import type { StepOp, TransformStep } from "@/types/transform";

function moveStep(steps: TransformStep[], index: number, delta: number) {
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= steps.length) return steps;
  const next = [...steps];
  [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
  return next;
}

function StepIcon({ op, className }: { op: StepOp; className?: string }) {
  const Icon = STEP_OP_ICONS[op];
  return (
    <span
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-lg bg-accent-subtle text-accent ring-1 ring-inset ring-accent/20",
        className,
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
    </span>
  );
}

export function CleanStepsPanel({
  steps,
  baseColumns,
  messages,
  disabled,
  addOpen,
  onAddOpenChange,
  onChange,
}: {
  steps: TransformStep[];
  baseColumns: DatasetColumn[];
  messages: Messages;
  disabled?: boolean;
  addOpen: boolean;
  onAddOpenChange: (open: boolean) => void;
  onChange: (steps: TransformStep[]) => void;
}) {
  const t = messages.transform;
  const [editor, setEditor] = useState<{ index: number | null; draft: TransformStep } | null>(null);

  const stepLabels: Record<StepOp, string> = useMemo(
    () => ({
      select: t.opSelect,
      drop: t.opSelect,
      rename: t.opRename,
      filter: t.opFilter,
      derive: t.opDerive,
      trim: t.opTrim,
      replace: t.opReplace,
      split: t.opSplit,
      cast: t.opCast,
      fill_null: t.opFillNull,
      sort: t.opSort,
      unique: t.opUnique,
    }),
    [t],
  );
  const stepHints: Record<StepOp, string> = useMemo(
    () => ({
      select: t.opSelectHint,
      drop: t.opSelectHint,
      rename: t.opRenameHint,
      filter: t.opFilterHint,
      derive: t.opDeriveHint,
      trim: t.opTrimHint,
      replace: t.opReplaceHint,
      split: t.opSplitHint,
      cast: t.opCastHint,
      fill_null: t.opFillNullHint,
      sort: t.opSortHint,
      unique: t.opUniqueHint,
    }),
    [t],
  );

  const editorColumns = editor
    ? resolveColumnsAtStep(baseColumns, steps, editor.index ?? steps.length)
    : [];
  const EditorIcon = editor ? STEP_OP_ICONS[editor.draft.op] : Plus;

  function openEditor(index: number | null, draft: TransformStep) {
    onAddOpenChange(false);
    setEditor({ index, draft: structuredClone(draft) });
  }

  function pickMethod(op: StepOp) {
    if (op === "select") {
      const available = resolveColumnsAtStep(baseColumns, steps, steps.length);
      openEditor(null, { op: "select", columns: available.map((column) => column.name) });
      return;
    }
    openEditor(null, emptyStep(op));
  }

  function applyEditor() {
    if (!editor) return;
    if (editor.index == null) onChange([...steps, editor.draft]);
    else onChange(steps.map((step, index) => (index === editor.index ? editor.draft : step)));
    setEditor(null);
  }

  const wideEditor = editor?.draft.op === "filter" || editor?.draft.op === "derive";
  const editorFrame = wideEditor
    ? {
        className: "flex max-h-[min(90vh,44rem)] w-[min(52rem,96vw)]",
        minWidth: 560,
        minHeight: 360,
      }
    : {
        className: "flex max-h-[min(90vh,40rem)] w-[min(26rem,94vw)]",
        minWidth: 360,
        minHeight: 240,
      };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="scroll-pane min-h-0 flex-1 overflow-auto">
        {steps.length === 0 ? (
          <div className="grid h-full min-h-32 place-items-center px-4">
            <p className="text-sm text-text-secondary">{messages.empty.steps}</p>
          </div>
        ) : (
          <ol className="m-0 list-none p-0">
            {steps.map((step, index) => (
              <li key={`${step.op}-${index}`} className="border-b border-border">
                <div className="flex items-start gap-2.5 px-4 py-2.5">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg px-1 py-0.5 text-left outline-none hover:bg-subtle/70"
                    disabled={disabled}
                    onClick={() => openEditor(index, step)}
                  >
                    <StepIcon op={step.op} className="mt-0.5 size-7" />
                    <span className="min-w-0 flex-1">
                      <p className="text-[13px] font-semibold text-text">
                        {index + 1}. {stepLabels[step.op]}
                      </p>
                      <p
                        className={cn(
                          "mt-0.5 break-words text-[12px] leading-5 text-text-secondary",
                          (step.op === "filter" || step.op === "derive") && "font-mono text-[11px]",
                        )}
                      >
                        {formatTransformStepSummary(step)}
                      </p>
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-1 pt-0.5">
                    <Button
                      type="button"
                      variant="quiet"
                      disabled={disabled || index === 0}
                      aria-label={t.reorderUp}
                      onClick={() => onChange(moveStep(steps, index, -1))}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      variant="quiet"
                      disabled={disabled || index === steps.length - 1}
                      aria-label={t.reorderDown}
                      onClick={() => onChange(moveStep(steps, index, 1))}
                    >
                      ↓
                    </Button>
                    <Button
                      type="button"
                      variant="quiet"
                      className="h-7 gap-1 px-2 text-[11px]"
                      disabled={disabled}
                      onClick={() => openEditor(index, step)}
                    >
                      <Pencil className="size-3.5" aria-hidden="true" />
                      {messages.common.edit}
                    </Button>
                    <Button
                      type="button"
                      variant="quiet"
                      className="h-7 gap-1 px-2 text-[11px]"
                      disabled={disabled}
                      onClick={() => onChange(steps.filter((_, itemIndex) => itemIndex !== index))}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                      {messages.common.delete}
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      <AppDialog
        open={addOpen}
        title={t.addStep}
        icon={<Plus className="size-4 text-accent" aria-hidden="true" />}
        className="flex max-h-[min(36rem,88vh)] w-[min(26rem,94vw)]"
        minWidth={360}
        minHeight={280}
        onClose={() => onAddOpenChange(false)}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <p className="shrink-0 border-b border-border bg-raised px-4 py-3 text-[13px] leading-5 text-text-secondary">
            {t.addStepHint}
          </p>
          <div className="scroll-pane min-h-0 flex-1 overflow-y-auto p-3">
            <div className="flex flex-col gap-1.5">
              {STEP_OPS.map((op) => {
                const Icon = STEP_OP_ICONS[op];
                return (
                  <button
                    key={op}
                    type="button"
                    className="flex w-full items-start gap-3 rounded-xl border border-border bg-surface px-3 py-2.5 text-left outline-none hover:border-accent/40 hover:bg-accent-subtle/60"
                    onClick={() => pickMethod(op)}
                  >
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-subtle text-accent ring-1 ring-inset ring-accent/20">
                      <Icon className="size-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-semibold text-text">{stepLabels[op]}</span>
                      <span className="mt-0.5 block text-[12px] leading-5 text-text-secondary">
                        {stepHints[op]}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </AppDialog>

      <AppDialog
        open={Boolean(editor)}
        title={editor ? stepLabels[editor.draft.op] : t.addStep}
        icon={<EditorIcon className="size-4 text-accent" aria-hidden="true" />}
        className={editorFrame.className}
        minWidth={editorFrame.minWidth}
        minHeight={editorFrame.minHeight}
        onClose={() => setEditor(null)}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setEditor(null)}>
              {messages.common.cancel}
            </Button>
            <Button type="button" variant="primary" onClick={applyEditor}>
              {messages.common.confirm}
            </Button>
          </>
        }
      >
        {editor ? (
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <p className="mb-3 rounded-lg border border-border bg-raised px-3 py-2 text-[13px] leading-5 text-text-secondary">
              {stepHints[editor.draft.op]}
            </p>
            <StepFields
              step={editor.draft}
              columns={editorColumns}
              onChange={(draft) => setEditor({ ...editor, draft })}
              messages={messages}
            />
          </div>
        ) : null}
      </AppDialog>
    </div>
  );
}
