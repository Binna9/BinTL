import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowUpDown,
  BookmarkPlus,
  Braces,
  ChevronRight,
  Columns3,
  CopyMinus,
  Database,
  Eye,
  FileDown,
  FileOutput,
  FileSpreadsheet,
  Filter,
  Plus,
  Replace,
  RotateCcw,
  Search,
  TextCursorInput,
  Trash2,
  Type,
  Upload,
  ArrowLeft,
  Play,
  type LucideIcon,
} from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import {
  columnWidthsForContent,
  DataGrid,
  EmptyGridRow,
  GridCell,
  GridRow,
} from "@/components/DataGrid";
import { CombineSetup } from "@/components/transform/CombineSetup";
import { TransformModeNav } from "@/components/transform/TransformModeNav";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { SplitLayout } from "@/layouts/SplitLayout";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { MetaField } from "@/components/ui/meta-field";
import { PaneHeader } from "@/components/ui/pane-header";
import { Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { fmtBytes } from "@/lib/format";
import { layout } from "@/lib/layout";
import { showConfirm, toastDeleteError, toastError, toastSuccess } from "@/lib/notifications";
import { HttpError } from "@/services/httpClient";
import { selectableClass } from "@/lib/selectable";
import {
  canPreviewCombine,
  combineDraftFromSpec,
  combineDraftToSpec,
  editorModeFromPath,
  emptyCombineDraft,
  transformEditorPath,
  type CombineDraft,
} from "@/lib/transformEditor";
import { chipApi } from "@/services/chips/chipApi";
import { datasetApi } from "@/services/transform/datasetApi";
import { transformApi } from "@/services/transform/transformApi";
import type { Dataset, DatasetColumn, FramePreview } from "@/types/dataset";
import type { ChipInputSlotResponse } from "@/types/chip";
import type {
  StepOp,
  TransformSpecV2,
  TransformStep,
} from "@/types/transform";

function normalizeSlotColumns(
  columns: { name: string; dtype?: string; type?: string }[] | undefined,
): DatasetColumn[] {
  if (!columns) return [];
  return columns.map((column) => ({
    name: column.name,
    dtype: column.dtype ?? column.type ?? "String",
  }));
}

function datasetFromSlot(slot: ChipInputSlotResponse): Dataset | null {
  if (slot.mode === "materialized" && slot.dataset) {
    return slot.dataset as unknown as Dataset;
  }
  if (slot.mode === "planned" && slot.planned) {
    const raw = slot.dataset as Dataset | undefined;
    if (!raw) {
      return {
        id: slot.planned.dataset_id,
        kind: "database",
        filename: slot.source_chip_name || "planned input",
        stored_path: "",
        size_bytes: null,
        delimiter: ",",
        has_header: true,
        columns: normalizeSlotColumns(slot.planned.columns),
        row_count: null,
        inspected_at: null,
        created_at: "",
        updated_at: "",
        workspace_id: "",
        producer_chip_run_id: null,
        status: "planned",
        source_chip_id: slot.planned.source_chip_id,
        consumer_chip_id: slot.planned.consumer_chip_id,
        available: false,
        origin: null,
      };
    }
    return {
      ...raw,
      status: raw.status ?? "planned",
      columns: raw.columns?.length
        ? raw.columns
        : normalizeSlotColumns(slot.planned.columns),
      available: false,
    };
  }
  return null;
}

const STEP_OPS: StepOp[] = [
  "select",
  "filter",
  "cast",
  "fill_null",
  "sort",
  "unique",
  "rename",
];

const STEP_OP_ICONS: Record<StepOp, LucideIcon> = {
  select: Columns3,
  drop: Columns3,
  rename: TextCursorInput,
  filter: Filter,
  cast: Type,
  fill_null: Replace,
  sort: ArrowUpDown,
  unique: CopyMinus,
};

const CAST_TYPES = ["Int64", "Int32", "Float64", "Float32", "String", "Boolean"];
const FILTER_OPS = [">=", "<=", "!=", "=", ">", "<"] as const;
type FilterOp = (typeof FILTER_OPS)[number];
const KIND_ORDER = ["upload", "database", "api", "transform"] as const;
const KIND_APPEARANCE = {
  upload: {
    icon: Upload,
    header: "border-accent/20 bg-accent-subtle text-accent",
    count: "bg-accent/10 text-accent",
  },
  database: {
    icon: Database,
    header: "border-success/20 bg-success-subtle text-success",
    count: "bg-success/10 text-success",
  },
  transform: {
    icon: FileOutput,
    header: "border-accent/20 bg-accent-subtle text-accent",
    count: "bg-accent/10 text-accent",
  },
  api: {
    icon: Braces,
    header: "border-warning/20 bg-warning-subtle text-warning",
    count: "bg-warning/10 text-warning",
  },
} as const;

function emptyStep(op: StepOp): TransformStep {
  switch (op) {
    case "select":
    case "drop":
      return { op, columns: [] };
    case "rename":
      return { op, map: {} };
    case "filter":
      return { op, expr: "" };
    case "cast":
      return { op, columns: {} };
    case "fill_null":
      return { op, value: "", columns: [] };
    case "sort":
      return { op, by: [{ column: "", descending: false }] };
    case "unique":
      return { op, subset: [], keep: "first" };
  }
}

function resolveColumnsAtStep(
  base: DatasetColumn[],
  steps: TransformStep[],
  stepIndex: number,
): DatasetColumn[] {
  let cols = [...base];
  for (let i = 0; i < stepIndex; i++) {
    const step = steps[i];
    if (step.op === "select" && step.columns.length > 0) {
      const byName = new Map(cols.map((column) => [column.name, column]));
      cols = step.columns
        .map((name) => byName.get(name))
        .filter((column): column is DatasetColumn => column != null);
    } else if (step.op === "drop" && step.columns.length > 0) {
      const drop = new Set(step.columns);
      cols = cols.filter((column) => !drop.has(column.name));
    } else if (step.op === "rename") {
      cols = cols.map((column) => ({
        ...column,
        name: step.map[column.name] ?? column.name,
      }));
    }
  }
  return cols;
}

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
              title={column.dtype ? `${column.name} (${column.dtype})` : column.name}
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
              {column.dtype ? (
                <span className={cn("ml-1 font-normal", active ? "opacity-75" : "text-text-tertiary")}>
                  {column.dtype}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ColumnChipSinglePicker({
  columns,
  value,
  emptyLabel,
  onChange,
  badge,
}: {
  columns: DatasetColumn[];
  value: string;
  emptyLabel: string;
  onChange: (column: string) => void;
  badge?: (column: DatasetColumn) => string | null;
}) {
  if (columns.length === 0) {
    return <p className="text-xs text-text-tertiary">{emptyLabel}</p>;
  }

  return (
    <div className="scroll-pane -mx-0.5 overflow-x-auto px-0.5">
      <div className="flex flex-nowrap gap-1.5 pb-0.5">
        {columns.map((column) => {
          const active = value === column.name;
          const extra = badge?.(column);
          return (
            <button
              key={column.name}
              type="button"
              title={column.dtype ? `${column.name} (${column.dtype})` : column.name}
              aria-pressed={active}
              onClick={() => onChange(column.name)}
              className={cn(
                "shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                active
                  ? "border-accent bg-accent-subtle text-accent"
                  : extra
                    ? "border-success/40 bg-success-subtle/40 text-text-secondary hover:border-success/50"
                    : "border-border bg-raised text-text-tertiary hover:border-border hover:bg-subtle hover:text-text-secondary",
              )}
            >
              {column.name}
              {extra ? <span className="ml-1 font-normal opacity-80">{extra}</span> : null}
              {!extra && column.dtype ? (
                <span className={cn("ml-1 font-normal", active ? "opacity-75" : "text-text-tertiary")}>
                  {column.dtype}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RenameStepFields({
  step,
  columns,
  onChange,
  messages,
}: {
  step: Extract<TransformStep, { op: "rename" }>;
  columns: DatasetColumn[];
  onChange: (step: TransformStep) => void;
  messages: ReturnType<typeof useLanguage>["messages"];
}) {
  const [active, setActive] = useState(() => columns[0]?.name ?? "");

  useEffect(() => {
    if (active && columns.some((column) => column.name === active)) return;
    setActive(columns[0]?.name ?? "");
  }, [active, columns]);

  if (columns.length === 0) {
    return <p className="text-xs text-text-tertiary">{messages.transform.noColumns}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <ColumnChipSinglePicker
        columns={columns}
        value={active}
        emptyLabel={messages.transform.noColumns}
        onChange={setActive}
        badge={(column) => {
          const renamed = step.map[column.name];
          return renamed ? `→ ${renamed}` : null;
        }}
      />
      {active ? (
        <FormField label={messages.transform.renameNewName}>
          <input
            className="field-control"
            value={step.map[active] ?? ""}
            placeholder={active}
            onChange={(event) => {
              const nextName = event.target.value.trim();
              const next = { ...step.map };
              if (!nextName || nextName === active) delete next[active];
              else next[active] = nextName;
              onChange({ ...step, map: next });
            }}
          />
        </FormField>
      ) : (
        <p className="text-[11px] text-text-tertiary">{messages.transform.pickColumn}</p>
      )}
    </div>
  );
}

function CastStepFields({
  step,
  columns,
  onChange,
  messages,
}: {
  step: Extract<TransformStep, { op: "cast" }>;
  columns: DatasetColumn[];
  onChange: (step: TransformStep) => void;
  messages: ReturnType<typeof useLanguage>["messages"];
}) {
  const [active, setActive] = useState(() => columns[0]?.name ?? "");

  useEffect(() => {
    if (active && columns.some((column) => column.name === active)) return;
    setActive(columns[0]?.name ?? "");
  }, [active, columns]);

  if (columns.length === 0) {
    return <p className="text-xs text-text-tertiary">{messages.transform.noColumns}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <ColumnChipSinglePicker
        columns={columns}
        value={active}
        emptyLabel={messages.transform.noColumns}
        onChange={setActive}
        badge={(column) => step.columns[column.name] ?? null}
      />
      {active ? (
        <FormField label={messages.transform.castPickType}>
          <Select
            value={step.columns[active] ?? ""}
            options={[
              { value: "", label: messages.transform.castKeepOriginal },
              ...CAST_TYPES.map((type) => ({ value: type, label: type })),
            ]}
            onChange={(dtype) => {
              const next = { ...step.columns };
              if (!dtype) delete next[active];
              else next[active] = dtype;
              onChange({ ...step, columns: next });
            }}
          />
        </FormField>
      ) : (
        <p className="text-[11px] text-text-tertiary">{messages.transform.pickColumn}</p>
      )}
    </div>
  );
}

function SortStepFields({
  step,
  columns,
  onChange,
  messages,
}: {
  step: Extract<TransformStep, { op: "sort" }>;
  columns: DatasetColumn[];
  onChange: (step: TransformStep) => void;
  messages: ReturnType<typeof useLanguage>["messages"];
}) {
  if (columns.length === 0) {
    return <p className="text-xs text-text-tertiary">{messages.transform.noColumns}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {step.by.map((item, index) => (
        <div
          key={index}
          className="flex flex-col gap-2 rounded-lg border border-border/60 bg-raised/40 p-2.5"
        >
          <div className="flex items-start justify-between gap-2">
            <span className="pt-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-text-tertiary">
              {index + 1}
            </span>
            {step.by.length > 1 ? (
              <button
                type="button"
                className="grid size-6 place-items-center rounded text-text-tertiary hover:bg-subtle hover:text-danger"
                aria-label={messages.common.delete}
                onClick={() =>
                  onChange({
                    ...step,
                    by: step.by.filter((_, rowIndex) => rowIndex !== index),
                  })
                }
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <ColumnChipSinglePicker
            columns={columns}
            value={item.column}
            emptyLabel={messages.transform.noColumns}
            onChange={(column) => {
              const by = step.by.map((row, rowIndex) =>
                rowIndex === index ? { ...row, column } : row,
              );
              onChange({ ...step, by });
            }}
          />
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              aria-pressed={!item.descending}
              onClick={() => {
                const by = step.by.map((row, rowIndex) =>
                  rowIndex === index ? { ...row, descending: false } : row,
                );
                onChange({ ...step, by });
              }}
              className={cn(
                "rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors",
                !item.descending
                  ? "border-accent bg-accent-subtle text-accent"
                  : "border-border bg-surface text-text-secondary hover:bg-subtle",
              )}
            >
              {messages.transform.ascending}
            </button>
            <button
              type="button"
              aria-pressed={item.descending}
              onClick={() => {
                const by = step.by.map((row, rowIndex) =>
                  rowIndex === index ? { ...row, descending: true } : row,
                );
                onChange({ ...step, by });
              }}
              className={cn(
                "rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors",
                item.descending
                  ? "border-accent bg-accent-subtle text-accent"
                  : "border-border bg-surface text-text-secondary hover:bg-subtle",
              )}
            >
              {messages.transform.descending}
            </button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        className="h-8 self-start gap-1 px-2.5 text-[11px]"
        onClick={() =>
          onChange({
            ...step,
            by: [...step.by, { column: columns[0]?.name ?? "", descending: false }],
          })
        }
      >
        <Plus className="size-3.5" aria-hidden="true" />
        {messages.transform.sortAddKey}
      </Button>
    </div>
  );
}

function keptColumnsForStep(
  step: Extract<TransformStep, { op: "select" } | { op: "drop" }>,
  columns: DatasetColumn[],
): string[] {
  const names = columns.map((column) => column.name);
  if (step.op === "select") {
    return step.columns.length > 0 ? step.columns : names;
  }
  const drop = new Set(step.columns);
  return names.filter((name) => !drop.has(name));
}

function isColumnStepNoOp(
  step: Extract<TransformStep, { op: "select" } | { op: "drop" }>,
  columns: DatasetColumn[],
): boolean {
  const names = columns.map((column) => column.name);
  if (names.length === 0) return true;
  const kept = keptColumnsForStep(step, columns);
  return kept.length === names.length;
}

function usableSteps(steps: TransformStep[], baseColumns: DatasetColumn[]): TransformStep[] {
  const out: TransformStep[] = [];
  for (const [index, step] of steps.entries()) {
    const columnsAtStep = resolveColumnsAtStep(baseColumns, steps, index);
    switch (step.op) {
      case "select":
        if (step.columns.length > 0 && !isColumnStepNoOp(step, columnsAtStep)) {
          out.push({ op: "select", columns: step.columns });
        }
        break;
      case "drop":
        if (step.columns.length > 0 && !isColumnStepNoOp(step, columnsAtStep)) {
          out.push({ op: "select", columns: keptColumnsForStep(step, columnsAtStep) });
        }
        break;
      case "rename":
        if (Object.keys(step.map).length > 0) out.push(step);
        break;
      case "cast":
        if (Object.keys(step.columns).length > 0) out.push(step);
        break;
      case "filter":
        if (step.expr.trim().length > 0) out.push(step);
        break;
      case "fill_null":
        if (step.columns.length > 0 && step.value.trim().length > 0) out.push(step);
        break;
      case "sort":
        if (step.by.some((item) => item.column.trim())) out.push(step);
        break;
      case "unique":
        out.push(step);
        break;
    }
  }
  return out;
}

function specFrom(
  dataset: Dataset | null,
  steps: TransformStep[],
  baseColumns: DatasetColumn[],
): TransformSpecV2 {
  return {
    version: 2,
    sink: "parquet",
    read: {
      delimiter: dataset?.delimiter ?? undefined,
      has_header: dataset?.has_header ?? undefined,
    },
    steps: usableSteps(steps, baseColumns),
  };
}

function parseFilterExpr(expr: string): { column: string; op: FilterOp; value: string } | null {
  const raw = expr.trim();
  if (!raw) return null;
  for (const op of FILTER_OPS) {
    const at = raw.indexOf(op);
    if (at === -1) continue;
    const column = raw.slice(0, at).trim();
    const value = raw.slice(at + op.length).trim();
    if (!column) continue;
    return {
      column,
      op,
      value: value.replace(/^["']|["']$/g, ""),
    };
  }
  return null;
}

function isNumericDtype(dtype?: string): boolean {
  if (!dtype) return false;
  const d = dtype.toLowerCase();
  return (
    d.includes("int") ||
    d.includes("uint") ||
    d.includes("float") ||
    d === "i32" ||
    d === "i64" ||
    d === "f32" ||
    d === "f64"
  );
}

function isStringDtype(dtype?: string): boolean {
  if (!dtype) return false;
  const d = dtype.toLowerCase();
  return d.includes("str") || d.includes("utf") || d.includes("string") || d.includes("categorical");
}

function formatFilterValue(value: string, dtype?: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed;
  }
  if (isStringDtype(dtype) || (!isNumericDtype(dtype) && !/^-?\d+(\.\d+)?$/.test(trimmed))) {
    return `"${trimmed.replace(/"/g, '\\"')}"`;
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  return `"${trimmed.replace(/"/g, '\\"')}"`;
}

function buildFilterExpr(column: string, op: FilterOp, value: string, dtype?: string): string {
  const rhs = formatFilterValue(value, dtype);
  if (!column.trim() || !rhs) return "";
  return `${column.trim()} ${op} ${rhs}`;
}

function filterOpMeta(
  op: FilterOp,
  messages: ReturnType<typeof useLanguage>["messages"],
): { label: string; title: string } {
  switch (op) {
    case "=":
      return { label: "=", title: messages.transform.filterOpEq };
    case "!=":
      return { label: "≠", title: messages.transform.filterOpNe };
    case ">":
      return { label: ">", title: messages.transform.filterOpGt };
    case "<":
      return { label: "<", title: messages.transform.filterOpLt };
    case ">=":
      return { label: "≥", title: messages.transform.filterOpGte };
    case "<=":
      return { label: "≤", title: messages.transform.filterOpLte };
  }
}

function FilterStepFields({
  step,
  columns,
  onChange,
  messages,
}: {
  step: Extract<TransformStep, { op: "filter" }>;
  columns: DatasetColumn[];
  onChange: (step: TransformStep) => void;
  messages: ReturnType<typeof useLanguage>["messages"];
}) {
  const parsed = useMemo(() => parseFilterExpr(step.expr), [step.expr]);
  const [column, setColumn] = useState(parsed?.column ?? "");
  const [op, setOp] = useState<FilterOp>(parsed?.op ?? "=");
  const [value, setValue] = useState(parsed?.value ?? "");

  useEffect(() => {
    const next = parseFilterExpr(step.expr);
    setColumn(next?.column ?? "");
    setOp(next?.op ?? "=");
    setValue(next?.value ?? "");
  }, [step.expr]);

  function columnDtype(name: string) {
    return columns.find((item) => item.name === name)?.dtype;
  }

  function commit(nextColumn: string, nextOp: FilterOp, nextValue: string) {
    onChange({
      op: "filter",
      expr: buildFilterExpr(nextColumn, nextOp, nextValue, columnDtype(nextColumn)),
    });
  }

  if (columns.length === 0) {
    return <p className="text-xs text-text-tertiary">{messages.transform.noColumns}</p>;
  }

  const preview =
    column && value.trim()
      ? messages.transform.filterPreview(column, op, value.trim())
      : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="scroll-pane -mx-0.5 overflow-x-auto px-0.5">
        <div className="flex flex-nowrap gap-1.5 pb-0.5">
          {columns.map((item) => {
            const active = column === item.name;
            return (
              <button
                key={item.name}
                type="button"
                title={item.dtype ? `${item.name} (${item.dtype})` : item.name}
                aria-pressed={active}
                onClick={() => {
                  setColumn(item.name);
                  commit(item.name, op, value);
                }}
                className={cn(
                  "shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                  active
                    ? "border-accent bg-accent-subtle text-accent"
                    : "border-border bg-surface text-text-secondary hover:border-accent/40 hover:bg-subtle",
                )}
              >
                {item.name}
                {item.dtype ? (
                  <span className={cn("ml-1 font-normal", active ? "opacity-75" : "text-text-tertiary")}>
                    {item.dtype}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {column ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-raised/40 p-2.5">
          <div className="text-[10px] font-medium uppercase tracking-[0.06em] text-text-tertiary">
            {messages.transform.filterOperators}
          </div>
          <div className="flex flex-wrap gap-1">
            {FILTER_OPS.map((item) => {
              const meta = filterOpMeta(item, messages);
              const active = op === item;
              return (
                <button
                  key={item}
                  type="button"
                  title={meta.title}
                  aria-pressed={active}
                  onClick={() => {
                    setOp(item);
                    commit(column, item, value);
                  }}
                  className={cn(
                    "min-w-[2.25rem] rounded-lg border px-2 py-1 text-xs font-semibold transition-colors",
                    active
                      ? "border-accent bg-accent-subtle text-accent"
                      : "border-border bg-surface text-text-secondary hover:bg-subtle",
                  )}
                >
                  {meta.label}
                </button>
              );
            })}
          </div>
          <FormField label={messages.transform.filterValueLabel}>
            <input
              className="field-control technical"
              value={value}
              placeholder={messages.transform.filterValuePlaceholder}
              onChange={(event) => {
                const next = event.target.value;
                setValue(next);
                commit(column, op, next);
              }}
            />
          </FormField>
          {preview ? (
            <p className="font-mono text-[11px] text-text-secondary">{preview}</p>
          ) : null}
        </div>
      ) : (
        <p className="text-[11px] text-text-tertiary">{messages.transform.filterPickColumn}</p>
      )}
    </div>
  );
}

function PreviewGrid({
  preview,
  empty,
}: {
  preview: FramePreview | null;
  empty: string;
}) {
  if (!preview || preview.columns.length === 0) {
    return (
      <DataGrid headers={["—"]}>
        <EmptyGridRow cols={1} text={empty} />
      </DataGrid>
    );
  }
  const headers = preview.columns.map((column) => column.name);
  const widths = columnWidthsForContent(headers, preview.rows);
  return (
    <DataGrid className="h-full min-h-64" headers={headers} columnWidths={widths}>
      {preview.rows.length === 0 ? (
        <EmptyGridRow cols={headers.length} text={empty} />
      ) : (
        preview.rows.map((row, index) => (
          <GridRow key={index}>
            {headers.map((_, cellIndex) => (
              <GridCell key={cellIndex} mono title={row[cellIndex] ?? ""}>
                {row[cellIndex] ?? ""}
              </GridCell>
            ))}
          </GridRow>
        ))
      )}
    </DataGrid>
  );
}

export function TransformPage() {
  const { messages } = useLanguage();
  const { id } = useParams<{ id: string }>();
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const editorMode = editorModeFromPath(pathname);
  const editorSearch = searchParams.toString();
  const workspaceId = searchParams.get("workspace") ?? undefined;
  const chipId = searchParams.get("chip") ?? searchParams.get("input_chip") ?? undefined;
  const workspaceMode = Boolean(workspaceId && chipId);
  const navigate = useNavigate();
  const t = messages.transform;
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [datasetId, setDatasetId] = useState<string>();
  const [transformId, setTransformId] = useState<string>();
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<TransformStep[]>([]);
  const [sourcePreview, setSourcePreview] = useState<FramePreview | null>(null);
  const [resultPreview, setResultPreview] = useState<FramePreview | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<"source" | "result">("source");
  const [detailTick, setDetailTick] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [expandedKinds, setExpandedKinds] = useState<Set<(typeof KIND_ORDER)[number]>>(
    new Set(),
  );
  const [kindSearch, setKindSearch] = useState<
    Record<(typeof KIND_ORDER)[number], string>
  >({
    upload: "",
    database: "",
    transform: "",
    api: "",
  });
  const [busy, setBusy] = useState(false);
  const [addStepOpen, setAddStepOpen] = useState(false);
  const addStepRef = useRef<HTMLDivElement>(null);
  const addStepMenuRef = useRef<HTMLDivElement>(null);
  const [addStepPos, setAddStepPos] = useState<{ top: number; left: number } | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registerChipName, setRegisterChipName] = useState("");
  const [registerBusy, setRegisterBusy] = useState(false);
  const [linkedTransformId, setLinkedTransformId] = useState<string>();
  const [sourceMissing, setSourceMissing] = useState(false);
  const [inputSlot, setInputSlot] = useState<ChipInputSlotResponse | null>(null);
  const [combineDraft, setCombineDraft] = useState<CombineDraft | null>(null);
  const [rightPreview, setRightPreview] = useState<FramePreview | null>(null);

  const selected = datasets.find((item) => item.id === datasetId) ?? null;
  const savedTransformId = transformId ?? linkedTransformId;
  const columns = selected?.columns ?? [];
  const baseColumns =
    sourcePreview && sourcePreview.columns.length > 0 ? sourcePreview.columns : columns;
  const rightSelected =
    combineDraft?.rightDatasetId != null
      ? (datasets.find((item) => item.id === combineDraft.rightDatasetId) ?? null)
      : null;
  const rightColumns =
    rightPreview && rightPreview.columns.length > 0
      ? rightPreview.columns
      : (rightSelected?.columns ?? []);
  const commonJoinKeys = useMemo(() => {
    const rightNames = new Set(rightColumns.map((column) => column.name));
    return baseColumns.filter((column) => rightNames.has(column.name));
  }, [baseColumns, rightColumns]);
  const canPreviewRecipe =
    canPreviewCombine(combineDraft, datasetId) || usableSteps(steps, baseColumns).length > 0;
  const combineModeLabel =
    combineDraft?.mode === "union" ? t.combineModeUnion : t.combineModeJoin;
  const headerCopy =
    editorMode === "combine"
      ? { title: t.combineTitle, description: t.combineDescription }
      : editorMode === "aggregate"
        ? { title: t.aggregateTitle, description: t.aggregateDescription }
        : { title: t.title, description: t.description };

  function buildSpec(): TransformSpecV2 {
    const spec = specFrom(selected, steps, baseColumns);
    const combine = combineDraftToSpec(combineDraft);
    if (combine) spec.combine = combine;
    return spec;
  }

  const kindLabel: Record<string, string> = {
    upload: messages.transform.kindUpload,
    database: messages.transform.kindDatabase,
    transform: messages.transform.kindTransform,
    api: messages.transform.kindApi,
  };
  const stepLabels: Record<StepOp, string> = {
    select: messages.transform.opSelect,
    drop: messages.transform.opSelect,
    rename: messages.transform.opRename,
    filter: messages.transform.opFilter,
    cast: messages.transform.opCast,
    fill_null: messages.transform.opFillNull,
    sort: messages.transform.opSort,
    unique: messages.transform.opUnique,
  };
  const stepHints: Record<StepOp, string> = {
    select: messages.transform.opSelectHint,
    drop: messages.transform.opSelectHint,
    rename: messages.transform.opRenameHint,
    filter: messages.transform.opFilterHint,
    cast: messages.transform.opCastHint,
    fill_null: messages.transform.opFillNullHint,
    sort: messages.transform.opSortHint,
    unique: messages.transform.opUniqueHint,
  };

  async function refreshCatalog() {
    const datasetResponse = await datasetApi.list();
    setDatasets(datasetResponse.datasets);
  }

  useEffect(() => {
    void refreshCatalog().catch((err) =>
      toastError(messages.errors.workspace, err),
    );
  }, [messages]);

  useEffect(() => {
    if (!workspaceId || !chipId) {
      setInputSlot(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        let slot = await chipApi.getInputSlot(workspaceId, chipId);
        let dataset = datasetFromSlot(slot);
        if (!dataset) {
          const chip = await chipApi.get(chipId);
          const datasetId =
            typeof chip.config.input_dataset_id === "string"
              ? chip.config.input_dataset_id.trim()
              : "";
          if (datasetId) {
            const file = await datasetApi.get(datasetId);
            slot = {
              mode: "materialized",
              dataset_id: file.id,
              source_chip_name: file.filename,
              dataset: file as unknown as Record<string, unknown>,
            };
            dataset = file;
          }
        }
        if (cancelled) return;
        setInputSlot(slot);
        if (!dataset) return;
        setDatasets((current) => {
          const exists = current.some((item) => item.id === dataset.id);
          if (exists) {
            return current.map((item) => (item.id === dataset.id ? { ...item, ...dataset } : item));
          }
          return [...current, dataset];
        });
        setDatasetId(dataset.id);
        setName((current) => current || slot.source_chip_name || dataset.filename);
      } catch (err) {
        if (!cancelled) toastError(messages.errors.workspace, err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, chipId, messages]);

  useEffect(() => {
    if (!id) {
      setTransformId(undefined);
      return;
    }
    let cancelled = false;
    void transformApi
      .get(id)
      .then((row) => {
        if (cancelled) return;
        setTransformId(row.id);
        setDatasetId(row.dataset_id);
        setName(row.name);
        setSteps(Array.isArray(row.spec?.steps) ? row.spec.steps : []);
        setCombineDraft(combineDraftFromSpec(row.spec?.combine));
      })
      .catch((err) => {
        if (!cancelled) {
          toastError(messages.errors.workspace, err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, messages]);

  useEffect(() => {
    if (!datasetId) {
      setSourcePreview(null);
      setSourceMissing(false);
      return;
    }
    if (selected?.status === "planned") {
      setSourceMissing(false);
      if (selected.columns.length > 0) {
        setSourcePreview({
          columns: selected.columns,
          rows: [],
          sampled_rows: 0,
          row_count: 0,
          truncated: false,
        });
      } else {
        setSourcePreview(null);
      }
      return;
    }
    if (selected && !selected.available) {
      setSourcePreview(null);
      setSourceMissing(true);
      return;
    }
    setSourceMissing(false);
    let cancelled = false;
    void datasetApi
      .inspect(datasetId, 100)
      .then((inspected) => {
        if (cancelled) return;
        setDatasets((current) =>
          current.map((item) => (item.id === inspected.dataset.id ? inspected.dataset : item)),
        );
        setSourcePreview(inspected.preview);
      })
      .catch((err) => {
        if (cancelled) return;
        setSourcePreview(null);
        if (err instanceof HttpError && err.status === 404) {
          setSourceMissing(true);
          return;
        }
        toastError(messages.errors.inspect, err);
      });
    return () => {
      cancelled = true;
    };
  }, [datasetId, selected?.available, selected?.status, messages]);

  useEffect(() => {
    if (editorMode !== "combine" || combineDraft) return;
    setCombineDraft(emptyCombineDraft());
  }, [editorMode, combineDraft]);

  useEffect(() => {
    if (!combineDraft || combineDraft.mode !== "join" || !combineDraft.rightDatasetId) {
      setRightPreview(null);
      return;
    }
    let cancelled = false;
    void datasetApi
      .inspect(combineDraft.rightDatasetId, 100)
      .then((inspected) => {
        if (cancelled) return;
        setRightPreview(inspected.preview);
      })
      .catch((err) => {
        if (cancelled) return;
        setRightPreview(null);
        toastError(messages.errors.inspect, err);
      });
    return () => {
      cancelled = true;
    };
  }, [combineDraft?.rightDatasetId, combineDraft?.mode, messages]);

  useEffect(() => {
    if (!combineDraft || combineDraft.joinKeys.length > 0 || commonJoinKeys.length === 0) return;
    setCombineDraft((current) =>
      current ? { ...current, joinKeys: [commonJoinKeys[0]!.name] } : current,
    );
  }, [commonJoinKeys, combineDraft]);

  useEffect(() => {
    if (!datasetId || transformId) {
      setLinkedTransformId(undefined);
      return;
    }
    let cancelled = false;
    void transformApi
      .list()
      .then((response) => {
        if (cancelled) return;
        const linked = response.transforms.find((row) => row.dataset_id === datasetId);
        setLinkedTransformId(linked?.id);
      })
      .catch(() => {
        if (!cancelled) setLinkedTransformId(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [datasetId, transformId]);

  useEffect(() => {
    if (!detailOpen || !datasetId) return;
    const dataset = datasets.find((item) => item.id === datasetId) ?? null;
    if (dataset?.status === "planned") {
      setSourcePreview({
        columns: dataset.columns,
        rows: [],
        sampled_rows: 0,
        row_count: 0,
        truncated: false,
      });
      setResultPreview(null);
      setDetailLoading(false);
      return;
    }
    const spec = buildSpec();
    const previewCombine = canPreviewCombine(combineDraft, datasetId);
    const previewSteps = usableSteps(steps, baseColumns).length > 0;
    let cancelled = false;
    setDetailLoading(true);
    void Promise.allSettled([
      datasetApi.inspect(datasetId, 200),
      previewCombine || previewSteps
        ? datasetApi.preview(datasetId, spec, 200)
        : Promise.resolve(null),
    ])
      .then(([inspected, previewed]) => {
        if (cancelled) return;
        if (inspected.status === "fulfilled") {
          setDatasets((current) =>
            current.map((item) =>
              item.id === inspected.value.dataset.id ? inspected.value.dataset : item,
            ),
          );
          setSourcePreview(inspected.value.preview);
        } else {
          toastError(messages.errors.inspect, inspected.reason);
        }
        if (previewed.status === "fulfilled") {
          setResultPreview(previewed.value);
        } else if (previewed.status === "rejected" && (previewCombine || previewSteps)) {
          setResultPreview(null);
          toastError(messages.errors.previewTransform, previewed.reason);
        } else {
          setResultPreview(null);
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    detailOpen,
    datasetId,
    detailTick,
    messages,
    steps,
    combineDraft,
    datasets,
    baseColumns,
  ]);

  const grouped = useMemo(() => {
    return KIND_ORDER.map((kind) => ({
      kind,
      items: datasets.filter((item) => item.kind === kind),
    }));
  }, [datasets]);

  useEffect(() => {
    if (!addStepOpen) {
      setAddStepPos(null);
      return;
    }
    const box = addStepRef.current;
    if (box) {
      const rect = box.getBoundingClientRect();
      setAddStepPos({ top: rect.bottom + 6, left: rect.left });
    }
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (addStepRef.current?.contains(target) || addStepMenuRef.current?.contains(target)) {
        return;
      }
      setAddStepOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setAddStepOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [addStepOpen]);

  function openDetail(tab: "source" | "result") {
    if (!datasetId) return;
    setDetailTab(tab);
    setDetailOpen(true);
    setDetailTick((tick) => tick + 1);
  }

  function onNew() {
    setTransformId(undefined);
    setDatasetId(undefined);
    setName("");
    setSteps([]);
    setCombineDraft(null);
    setRightPreview(null);
    setSourcePreview(null);
    setResultPreview(null);
    navigate(transformEditorPath("clean", undefined, editorSearch));
  }

  async function saveTransformDefinition() {
    if (!datasetId) return;
    setBusy(true);
    try {
      const title = name.trim() || selected?.filename || messages.transform.untitled;
      if (transformId) {
        await transformApi.update(transformId, {
          name: title,
          dataset_id: datasetId,
          spec: buildSpec(),
          ...(chipId ? { input_chip_id: chipId } : {}),
        });
      } else {
        const row = await transformApi.create({
          name: title,
          dataset_id: datasetId,
          spec: buildSpec(),
          ...(chipId ? { input_chip_id: chipId } : {}),
        });
        setTransformId(row.id);
        setName(row.name);
        navigate(transformEditorPath(editorMode, row.id, editorSearch), { replace: true });
      }
      if (workspaceMode && workspaceId) {
        toastSuccess(messages.transform.saveToWorkspace);
        navigate(`/workspace/${workspaceId}/chips/${chipId}`);
        return;
      }
      toastSuccess(messages.query.taskRegistered);
    } catch (err) {
      toastError(messages.errors.saveTransform, err);
    } finally {
      setBusy(false);
    }
  }

  async function onRegisterChip() {
    if (!datasetId || !registerChipName.trim()) return;
    setRegisterBusy(true);
    try {
      const title = name.trim() || selected?.filename || messages.transform.untitled;
      let savedTransformId = transformId;
      if (savedTransformId) {
        await transformApi.update(savedTransformId, {
          name: title,
          dataset_id: datasetId,
          spec: buildSpec(),
          ...(chipId ? { input_chip_id: chipId } : {}),
        });
      } else {
        const row = await transformApi.create({
          name: title,
          dataset_id: datasetId,
          spec: buildSpec(),
          ...(chipId ? { input_chip_id: chipId } : {}),
        });
        savedTransformId = row.id;
        setTransformId(row.id);
        setName(row.name);
        navigate(transformEditorPath(editorMode, row.id, editorSearch), { replace: true });
      }
      await chipApi.register({
        name: registerChipName.trim(),
        kind: "transform",
        transform_id: savedTransformId,
      });
      setRegisterOpen(false);
      toastSuccess(messages.query.taskRegistered);
    } catch (err) {
      toastError(messages.errors.saveTransform, err);
    } finally {
      setRegisterBusy(false);
    }
  }

  function openRegister() {
    if (workspaceMode) {
      void saveTransformDefinition();
      return;
    }
    setRegisterChipName(name.trim() || selected?.filename || messages.transform.untitled);
    setRegisterOpen(true);
  }

  async function onDeleteSaved() {
    if (!savedTransformId) return;
    const title = name.trim() || selected?.filename || messages.transform.untitled;
    const confirmed = await showConfirm(
      messages.transform.deleteSavedRecipe,
      messages.transform.deleteSavedRecipeConfirm(title),
      { tone: "danger", confirmLabel: messages.common.delete },
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await transformApi.delete(savedTransformId);
      toastSuccess(messages.transform.deleteSavedRecipeDone);
      setLinkedTransformId(undefined);
      if (transformId) {
        onNew();
      }
    } catch (err) {
      toastDeleteError(messages.errors.deleteTransform, messages.errors.deleteBlocked, err);
    } finally {
      setBusy(false);
    }
  }

  async function onRun() {
    setBusy(true);
    try {
      let savedId = transformId;
      const title = name.trim() || selected?.filename || messages.transform.untitled;
      if (!datasetId) return;
      if (savedId) {
        await transformApi.update(savedId, {
          name: title,
          dataset_id: datasetId,
          spec: buildSpec(),
          ...(chipId ? { input_chip_id: chipId } : {}),
        });
      } else {
        const row = await transformApi.create({
          name: title,
          dataset_id: datasetId,
          spec: buildSpec(),
          ...(chipId ? { input_chip_id: chipId } : {}),
        });
        savedId = row.id;
        setTransformId(row.id);
        navigate(transformEditorPath(editorMode, row.id, editorSearch), {
          replace: true,
        });
      }
      if (workspaceMode && workspaceId && chipId) {
        await chipApi.run(chipId, { workspace_id: workspaceId });
        toastSuccess(messages.workspace.runQueued);
        navigate(`/workspace/${workspaceId}`);
        return;
      }
      const run = await transformApi.run(savedId);
      navigate(`/jobs/${run.id}`);
    } catch (err) {
      toastError(messages.errors.runJob, err);
    } finally {
      setBusy(false);
    }
  }

  function updateStep(index: number, next: TransformStep) {
    setSteps((current) => current.map((step, i) => (i === index ? next : step)));
  }

  const activePreview = detailTab === "result" ? resultPreview : sourcePreview;
  const previewHeaders = activePreview?.columns.map((column) => column.name) ?? [];

  return (
    <PageShell>
      <PageHeader
        iconName="jobs"
        eyebrow={messages.transform.eyebrow}
        title={headerCopy.title}
        description={headerCopy.description}
        actions={
          <>
            {workspaceMode && workspaceId ? (
              <Button
                type="button"
                variant="quiet"
                className="gap-2"
                disabled={busy}
                onClick={() => navigate(`/workspace/${workspaceId}`)}
              >
                <ArrowLeft className="size-3.5" aria-hidden="true" />
                {messages.workspace.backToCanvas}
              </Button>
            ) : (
              <Button type="button" variant="quiet" className="gap-2" disabled={busy} onClick={onNew}>
                <RotateCcw className="size-3.5" aria-hidden="true" />
                {messages.transform.reset}
              </Button>
            )}
            {savedTransformId ? (
              <Button
                type="button"
                variant="quiet"
                className="gap-2"
                disabled={busy}
                onClick={() => void onDeleteSaved()}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                {messages.transform.deleteSavedRecipe}
              </Button>
            ) : null}
            <Button
              type="button"
              className="gap-2"
              disabled={!datasetId || busy}
              onClick={() => openDetail(canPreviewRecipe ? "result" : "source")}
            >
              <Eye className="size-3.5" aria-hidden="true" />
              {messages.transform.previewSteps}
            </Button>
            <Button type="button" className="gap-2" disabled={!datasetId || busy} onClick={openRegister}>
              <BookmarkPlus className="size-3.5" aria-hidden="true" />
              {busy
                ? messages.common.saving
                : workspaceMode
                  ? messages.transform.saveToWorkspace
                  : messages.transform.register}
            </Button>
            <Button
              variant="primary"
              type="button"
              className="gap-2"
              disabled={!datasetId || busy}
              onClick={() => void onRun()}
            >
              {workspaceMode ? (
                <Play className="size-3.5" aria-hidden="true" />
              ) : (
                <FileDown className="size-3.5" aria-hidden="true" />
              )}
              {busy
                ? workspaceMode
                  ? messages.common.running
                  : messages.transform.exporting
                : workspaceMode
                  ? messages.transform.runChip
                  : messages.transform.resultFile}
            </Button>
          </>
        }
      />

      <Panel tall>
        <TransformModeNav
          mode={editorMode}
          transformId={savedTransformId}
          search={editorSearch}
          messages={messages}
        />
        <SplitLayout
          className="min-h-0 flex-1"
          defaultSizes={[layout.split.catalog]}
        >
          <aside className="flex min-h-0 flex-col overflow-hidden">
            {workspaceMode ? (
              <>
                <PaneHeader
                  title={messages.workspace.inspector}
                  meta={inputSlot?.source_chip_name ?? messages.transform.pickFile}
                />
                <div className="scroll-pane min-h-0 flex-1 overflow-auto bg-surface p-3">
                  {inputSlot?.mode === "unwired" ? (
                    <p className="text-sm leading-6 text-text-secondary">
                      {messages.transform.unwiredHint}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-sm font-semibold text-text">
                        {messages.transform.inputFromChip(
                          inputSlot?.source_chip_name
                            || selected?.filename
                            || messages.transform.untitled,
                        )}
                      </p>
                      {inputSlot?.mode === "planned" ? (
                        <p className="text-xs leading-5 text-text-secondary">
                          {messages.transform.schemaOnlyHint}
                        </p>
                      ) : (
                        <p className="text-xs text-text-tertiary">
                          {selected?.row_count != null
                            ? messages.common.rows(selected.row_count)
                            : selected?.filename}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
            <PaneHeader
              title={messages.transform.catalog}
              meta={messages.common.count(datasets.length)}
            />
            <div className="scroll-pane min-h-0 flex-1 overflow-auto bg-surface">
              <div className="space-y-2 p-2">
                  {grouped.map((group) => {
                    const appearance = KIND_APPEARANCE[group.kind];
                    const KindIcon = appearance.icon;
                    const expanded = expandedKinds.has(group.kind);
                    const query = kindSearch[group.kind].trim().toLocaleLowerCase();
                    const visibleItems = query
                      ? group.items.filter((item) =>
                          item.filename.toLocaleLowerCase().includes(query),
                        )
                      : group.items;
                    return (
                      <section
                        key={group.kind}
                        className="overflow-hidden rounded-lg border border-border bg-surface"
                      >
                        <button
                          type="button"
                          aria-expanded={expanded}
                          className={cn(
                            "flex w-full items-center gap-2 px-3 py-2.5 text-left transition-[filter] hover:brightness-95",
                            expanded && "border-b",
                            appearance.header,
                          )}
                          onClick={() =>
                            setExpandedKinds((current) => {
                              const next = new Set(current);
                              if (expanded) next.delete(group.kind);
                              else next.add(group.kind);
                              return next;
                            })
                          }
                        >
                          <KindIcon className="size-4 shrink-0" aria-hidden="true" />
                          <span className="min-w-0 flex-1 text-sm font-bold">
                            {kindLabel[group.kind] ?? group.kind}
                          </span>
                          <span
                            className={cn(
                              "rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums",
                              appearance.count,
                            )}
                          >
                            {group.items.length}
                          </span>
                          <ChevronRight
                            className={cn(
                              "size-4 shrink-0 transition-transform",
                              expanded && "rotate-90",
                            )}
                            aria-hidden="true"
                          />
                        </button>
                        {expanded ? (
                          <div className="border-b border-border bg-raised p-2.5">
                            <div className="group flex h-9 items-center overflow-hidden rounded-lg border border-border bg-surface shadow-sm transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
                              <span className="grid h-full w-9 shrink-0 place-items-center border-r border-border bg-subtle text-text-tertiary transition-colors group-focus-within:text-accent">
                                <Search className="size-3.5" aria-hidden="true" />
                              </span>
                              <input
                                type="search"
                                className="min-w-0 flex-1 bg-transparent px-3 text-[13px] text-text outline-none placeholder:text-text-tertiary"
                                value={kindSearch[group.kind]}
                                placeholder={messages.transform.searchFiles}
                                aria-label={`${kindLabel[group.kind]} ${messages.transform.searchFiles}`}
                                onChange={(event) =>
                                  setKindSearch((current) => ({
                                    ...current,
                                    [group.kind]: event.target.value,
                                  }))
                                }
                              />
                            </div>
                          </div>
                        ) : null}
                        {expanded && visibleItems.length === 0 ? (
                          <p className="px-3 py-4 text-center text-xs text-text-tertiary">
                            {messages.transform.noMatchingFiles}
                          </p>
                        ) : null}
                        {expanded &&
                          visibleItems.map((item) => (
                            <button
                              key={item.id}
                              type="button"
                              className={cn(
                                "flex w-full min-w-0 items-start gap-2 border-b border-border px-3 py-2.5 text-left last:border-b-0",
                                selectableClass(item.id === datasetId),
                              )}
                              onClick={() => {
                                const selecting = datasetId !== item.id;
                                setDatasetId(selecting ? item.id : undefined);
                                if (selecting && !transformId) {
                                  setName((current) => current || item.filename);
                                }
                              }}
                            >
                              <FileSpreadsheet className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
                              <span className="min-w-0 flex-1">
                                <span className="block break-all text-[13px] font-medium leading-4">
                                  {item.filename}
                                  {item.status === "planned" ? (
                                    <span className="ml-1 text-[11px] font-normal text-accent">
                                      ({messages.transform.plannedInput})
                                    </span>
                                  ) : !item.available ? (
                                    <span className="ml-1 text-[11px] font-normal text-warning">
                                      ({messages.transform.sourceUnavailable})
                                    </span>
                                  ) : null}
                                </span>
                                <span className="mt-0.5 block truncate text-[11px] text-text-tertiary">
                                  {item.origin?.connection_name
                                    ? `${item.origin.connection_name} · ${item.origin.table_name}`
                                    : item.size_bytes != null
                                      ? fmtBytes(item.size_bytes)
                                      : item.id.slice(0, 8)}
                                </span>
                              </span>
                            </button>
                          ))}
                      </section>
                    );
                  })}
                </div>
            </div>
              </>
            )}
          </aside>

          <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            <PaneHeader
              title={editorMode === "combine" ? t.combineSetup : messages.transform.setup}
              meta={
                editorMode === "combine"
                  ? combineModeLabel
                  : editorMode === "aggregate"
                    ? messages.transform.soonPending
                    : messages.common.count(steps.length)
              }
              afterMeta={
                editorMode === "clean" ? (
                <div className="relative" ref={addStepRef}>
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-7 gap-1 px-2 text-[11px]"
                    disabled={!selected}
                    title={messages.transform.addStep}
                    aria-expanded={addStepOpen}
                    aria-haspopup="menu"
                    onClick={() => setAddStepOpen((open) => !open)}
                  >
                    <Plus className="size-3.5 shrink-0" aria-hidden="true" />
                    {messages.transform.addStep}
                  </Button>
                  {addStepOpen && addStepPos
                    ? createPortal(
                        <div
                          ref={addStepMenuRef}
                          role="menu"
                          className="scroll-pane fixed z-[220] w-72 overflow-y-auto rounded-xl border border-border bg-surface py-1 shadow-[0_10px_28px_rgba(15,23,42,0.14)] dark:shadow-[0_14px_32px_rgba(0,0,0,0.48)]"
                          style={{ top: addStepPos.top, left: addStepPos.left, maxHeight: 320 }}
                        >
                          {STEP_OPS.map((op) => {
                            const Icon = STEP_OP_ICONS[op];
                            return (
                              <button
                                key={op}
                                type="button"
                                role="menuitem"
                                className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-accent-subtle"
                                onClick={() => {
                                  if (op === "select") {
                                    const available = resolveColumnsAtStep(
                                      baseColumns,
                                      steps,
                                      steps.length,
                                    );
                                    setSteps((current) => [
                                      ...current,
                                      {
                                        op: "select",
                                        columns: available.map((column) => column.name),
                                      },
                                    ]);
                                  } else {
                                    setSteps((current) => [...current, emptyStep(op)]);
                                  }
                                  setAddStepOpen(false);
                                }}
                              >
                                <Icon
                                  className="mt-0.5 size-4 shrink-0 text-text-tertiary"
                                  aria-hidden="true"
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block text-[13px] font-semibold text-text">
                                    {stepLabels[op]}
                                  </span>
                                  <span className="mt-0.5 block text-[11px] leading-4 text-text-tertiary">
                                    {stepHints[op]}
                                  </span>
                                </span>
                              </button>
                            );
                          })}
                        </div>,
                        document.body,
                      )
                    : null}
                </div>
                ) : null
              }
            />
            {!selected ? (
              <div className="flex min-h-0 flex-1 items-center justify-center px-4">
                <p className="text-sm text-text-tertiary">{messages.transform.pickFile}</p>
              </div>
            ) : (
              <>
                <div className="grid items-stretch gap-4 border-b border-border px-4 py-3 md:grid-cols-2">
                  <FormField label={messages.transform.namePlaceholder}>
                    <div className="flex h-[3.25rem] items-start gap-2 rounded border border-border bg-surface px-2.5 py-1.5 text-[13px] focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
                      <FileSpreadsheet className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
                      <textarea
                        rows={2}
                        className="h-[2.5rem] min-w-0 flex-1 resize-none overflow-x-auto overflow-y-auto bg-transparent leading-5 text-text outline-none placeholder:text-text-tertiary"
                        value={name}
                        placeholder={messages.transform.namePlaceholder}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </div>
                  </FormField>
                  <FormField label={messages.transform.selectedFile}>
                    <div className="flex h-[3.25rem] items-start gap-2 rounded border border-border bg-raised px-2.5 py-1.5 text-[13px]">
                      <FileSpreadsheet className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
                      <span
                        title={selected.filename}
                        className="line-clamp-2 h-[2.5rem] min-w-0 flex-1 overflow-hidden break-all leading-5"
                      >
                        {selected.filename}
                      </span>
                    </div>
                  </FormField>
                </div>
                {sourceMissing ? (
                  <p className="border-b border-border px-4 py-2.5 text-[11px] leading-5 text-warning">
                    {messages.transform.sourceFileMissing}
                  </p>
                ) : null}
                {editorMode === "aggregate" ? (
                  <div className="scroll-pane min-h-0 flex-1 overflow-auto p-4">
                    <p className="text-sm leading-6 text-text-secondary">{t.aggregateHint}</p>
                  </div>
                ) : editorMode === "combine" && combineDraft ? (
                  <CombineSetup
                    messages={messages}
                    draft={combineDraft}
                    datasetId={datasetId}
                    datasets={datasets}
                    leftColumns={baseColumns}
                    commonJoinKeys={commonJoinKeys}
                    onChange={setCombineDraft}
                  />
                ) : (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="scroll-pane min-h-0 flex-1 overflow-auto">
                    {steps.length === 0 ? (
                      <div className="grid h-full min-h-32 place-items-center px-4">
                        <p className="text-sm text-text-tertiary">{messages.empty.steps}</p>
                      </div>
                    ) : (
                      steps.map((step, index) => (
                        <article key={`${step.op}-${index}`} className="border-b border-border p-3">
                          <div className="mb-2 flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <span className="text-xs font-semibold uppercase tracking-[0.06em]">
                                {index + 1}. {stepLabels[step.op]}
                              </span>
                              <p className="mt-1 text-[11px] leading-4 text-text-tertiary">
                                {stepHints[step.op]}
                              </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <Button
                                type="button"
                                variant="quiet"
                                disabled={index === 0}
                                onClick={() =>
                                  setSteps((current) => {
                                    const next = [...current];
                                    [next[index - 1], next[index]] = [next[index], next[index - 1]];
                                    return next;
                                  })
                                }
                              >
                                ↑
                              </Button>
                              <Button
                                type="button"
                                variant="quiet"
                                disabled={index === steps.length - 1}
                                onClick={() =>
                                  setSteps((current) => {
                                    const next = [...current];
                                    [next[index], next[index + 1]] = [next[index + 1], next[index]];
                                    return next;
                                  })
                                }
                              >
                                ↓
                              </Button>
                              <Button
                                type="button"
                                variant="quiet"
                                onClick={() =>
                                  setSteps((current) => current.filter((_, i) => i !== index))
                                }
                              >
                                <Trash2 className="size-3.5" aria-hidden="true" />
                              </Button>
                            </div>
                          </div>
                          <StepFields
                            step={step}
                            columns={resolveColumnsAtStep(baseColumns, steps, index)}
                            onChange={(next) => updateStep(index, next)}
                            messages={messages}
                          />
                        </article>
                      ))
                    )}
                  </div>
                  <p className="shrink-0 border-t border-border px-4 py-2.5 text-[11px] leading-4 text-text-tertiary">
                    {messages.transform.registerHint}
                  </p>
                </div>
                )}
              </>
            )}
          </section>
        </SplitLayout>
      </Panel>

      <AppDialog
        open={detailOpen}
        title={selected?.filename ?? messages.transform.previewSteps}
        icon={<FileSpreadsheet className="size-4 text-accent" aria-hidden="true" />}
        className="h-[min(42rem,88vh)] w-[min(72rem,94vw)]"
        minWidth={520}
        minHeight={360}
        onClose={() => setDetailOpen(false)}
        headerExtra={
          <div className="flex gap-1">
            <Button
              type="button"
              variant={detailTab === "source" ? "secondary" : "quiet"}
              onClick={() => setDetailTab("source")}
            >
              {messages.transform.inspect}
            </Button>
            <Button
              type="button"
              variant={detailTab === "result" ? "secondary" : "quiet"}
              onClick={() => setDetailTab("result")}
            >
              {messages.transform.resultPreview}
            </Button>
          </div>
        }
        footer={
          <Button type="button" variant="secondary" onClick={() => setDetailOpen(false)}>
            {messages.common.close}
          </Button>
        }
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {activePreview ? (
            <div className="flex min-w-0 shrink-0 flex-wrap items-start gap-5 border-b border-border px-4 py-2.5">
              <MetaField label={messages.files.previewRows} technical>
                {messages.common.rows(activePreview.sampled_rows)}
              </MetaField>
              {activePreview.row_count != null ? (
                <MetaField label={messages.files.totalRows} technical>
                  {messages.common.rows(activePreview.row_count)}
                </MetaField>
              ) : null}
              {previewHeaders.length > 0 ? (
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-medium leading-none text-text-tertiary">
                    {messages.common.columns}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {activePreview.columns.map((column) => (
                      <span
                        key={column.name}
                        title={`${column.name} ${column.dtype}`}
                        className="max-w-full truncate rounded-full border border-border bg-raised px-2 py-0.5 text-[11px] font-medium text-text"
                      >
                        {column.name}
                        <span className="ml-1 text-text-tertiary">{column.dtype}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden p-4">
            {detailLoading ? (
              <div className="grid h-full min-h-64 place-items-center text-sm text-text-tertiary">
                {messages.common.loading}
              </div>
            ) : (
              <PreviewGrid
                preview={activePreview}
                empty={
                  detailTab === "result"
                    ? editorMode === "combine" && !canPreviewCombine(combineDraft, datasetId)
                      ? t.combinePreviewHint
                      : messages.transform.previewHint
                    : messages.empty.preview
                }
              />
            )}
          </div>
        </div>
      </AppDialog>

      <AppDialog
        open={registerOpen}
        title={messages.transform.register}
        icon={<BookmarkPlus className="size-4 text-accent" aria-hidden="true" />}
        className="w-[min(22rem,92vw)]"
        minWidth={320}
        minHeight={220}
        zIndex={120}
        onClose={() => setRegisterOpen(false)}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setRegisterOpen(false)}>
              {messages.common.cancel}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={registerBusy || !registerChipName.trim()}
              onClick={() => void onRegisterChip()}
            >
              {registerBusy ? messages.common.saving : messages.common.save}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 p-4">
          <p className="text-[11px] leading-5 text-text-tertiary">{messages.transform.registerHint}</p>
          <FormField label={messages.workspace.chipName}>
            <input
              className="field-control"
              value={registerChipName}
              autoFocus
              onChange={(event) => setRegisterChipName(event.target.value)}
            />
          </FormField>
          <dl className="space-y-2 border-t border-border/60 pt-3 text-[11px] text-text-tertiary">
            <div className="flex gap-2">
              <dt className="w-14 shrink-0">{messages.transform.selectedFile}</dt>
              <dd className="min-w-0 truncate text-text-secondary">{selected?.filename ?? "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-14 shrink-0">{messages.transform.steps}</dt>
              <dd className="text-text-secondary">{messages.transform.registerSummarySteps(steps.length)}</dd>
            </div>
          </dl>
        </div>
      </AppDialog>
    </PageShell>
  );
}

function StepFields({
  step,
  columns,
  onChange,
  messages,
}: {
  step: TransformStep;
  columns: DatasetColumn[];
  onChange: (step: TransformStep) => void;
  messages: ReturnType<typeof useLanguage>["messages"];
}) {
  switch (step.op) {
    case "select":
    case "drop": {
      const kept = keptColumnsForStep(step, columns);
      return (
        <ColumnChipPicker
          columns={columns}
          value={kept}
          emptyLabel={messages.transform.noColumns}
          onChange={(next) => onChange({ op: "select", columns: next })}
        />
      );
    }
    case "rename":
      return (
        <RenameStepFields
          step={step}
          columns={columns}
          onChange={onChange}
          messages={messages}
        />
      );
    case "filter":
      return (
        <FilterStepFields
          step={step}
          columns={columns}
          onChange={onChange}
          messages={messages}
        />
      );
    case "cast":
      return (
        <CastStepFields
          step={step}
          columns={columns}
          onChange={onChange}
          messages={messages}
        />
      );
    case "fill_null":
      return (
        <div className="flex flex-col gap-3">
          <ColumnChipPicker
            columns={columns}
            value={step.columns}
            emptyLabel={messages.transform.noColumns}
            minSelected={0}
            onChange={(next) => onChange({ ...step, columns: next })}
          />
          <FormField label={messages.transform.fillValue}>
            <input
              className="field-control"
              value={step.value}
              placeholder={messages.transform.fillValue}
              onChange={(event) => onChange({ ...step, value: event.target.value })}
            />
          </FormField>
        </div>
      );
    case "sort":
      return (
        <SortStepFields
          step={step}
          columns={columns}
          onChange={onChange}
          messages={messages}
        />
      );
    case "unique":
      return (
        <div className="flex flex-col gap-3">
          <ColumnChipPicker
            columns={columns}
            value={step.subset ?? []}
            emptyLabel={messages.transform.noColumns}
            minSelected={0}
            onChange={(next) => onChange({ ...step, subset: next })}
          />
          <Select
            value={step.keep ?? "first"}
            options={[
              { value: "first", label: messages.transform.keepFirst },
              { value: "last", label: messages.transform.keepLast },
              { value: "any", label: messages.transform.keepAny },
              { value: "none", label: messages.transform.keepNone },
            ]}
            onChange={(value) =>
              onChange({
                ...step,
                keep: value as "first" | "last" | "none" | "any",
              })
            }
          />
        </div>
      );
  }
}
