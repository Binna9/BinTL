import { ReactNode, useEffect, useId, useMemo, useState } from "react";
import { Plus, Search, Trash2, Check } from "lucide-react";
import { columnWidthsForContent, DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Select } from "@/components/ui/select";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { selectableClass } from "@/lib/selectable";
import type { Dataset, DatasetColumn, FramePreview } from "@/types/dataset";
import type { TransformSpecV2, TransformStep } from "@/types/transform";
import {
  CAST_TYPES,
  DERIVE_OPS,
  FILTER_OPS,
  buildDeriveExpr,
  filterOpNeedsValue,
  parseDeriveExpr,
  resolveColumnsAtStep,
  type DeriveOp,
  type FilterOp,
} from "@/features/transform/transformEditorModel";

function ColumnPickerList({
  columns,
  emptyLabel,
  selected,
  multiple,
  minSelected = 1,
  badge,
  fill = false,
  className,
  onToggle,
  onSetSelected,
}: {
  columns: DatasetColumn[];
  emptyLabel: string;
  selected: Set<string>;
  multiple: boolean;
  minSelected?: number;
  badge?: (column: DatasetColumn) => string | null;
  fill?: boolean;
  className?: string;
  onToggle: (name: string) => void;
  onSetSelected?: (columns: string[]) => void;
}) {
  const { messages } = useLanguage();
  const groupId = useId();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();
  const visible = needle
    ? columns.filter((column) => {
        const dtype = column.dtype ?? "";
        return (
          column.name.toLocaleLowerCase().includes(needle)
          || dtype.toLocaleLowerCase().includes(needle)
        );
      })
    : columns;
  const selectedCount = columns.filter((column) => selected.has(column.name)).length;
  const visibleSelected = visible.filter((column) => selected.has(column.name)).length;
  const showSearch = columns.length > 6;

  function selectVisible() {
    const visibleNames = new Set(visible.map((column) => column.name));
    onSetSelected?.(
      columns
        .filter((column) => selected.has(column.name) || visibleNames.has(column.name))
        .map((column) => column.name),
    );
  }

  function deselectVisible() {
    const visibleNames = new Set(visible.map((column) => column.name));
    const kept = columns
      .filter((column) => selected.has(column.name) && !visibleNames.has(column.name))
      .map((column) => column.name);
    const extras = columns
      .filter((column) => selected.has(column.name) && visibleNames.has(column.name))
      .map((column) => column.name);
    const need = Math.max(0, minSelected - kept.length);
    onSetSelected?.([...kept, ...extras.slice(0, need)]);
  }

  if (columns.length === 0) {
    return <p className="text-xs text-text-tertiary">{emptyLabel}</p>;
  }

  return (
    <div
      className={cn(
        "flex w-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface",
        fill ? "h-full flex-1" : null,
        className ?? "w-full",
      )}
    >
      {showSearch || multiple ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-raised px-2 py-2">
          {showSearch ? (
            <div className="group flex h-8 min-w-0 flex-1 items-center overflow-hidden rounded-lg border border-border bg-surface focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
              <span className="grid h-full w-8 shrink-0 place-items-center text-text-tertiary group-focus-within:text-accent">
                <Search className="size-3.5" aria-hidden="true" />
              </span>
              <input
                type="search"
                className="min-w-0 flex-1 bg-transparent pr-2.5 text-[13px] text-text outline-none placeholder:text-text-tertiary"
                value={query}
                placeholder={messages.transform.searchColumns}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          ) : null}
          {multiple ? (
            <span className="shrink-0 rounded-full bg-accent-subtle px-2 py-0.5 text-[11px] font-semibold tabular-nums text-accent">
              {messages.transform.selectedColumns(selectedCount, columns.length)}
            </span>
          ) : null}
        </div>
      ) : null}
      {multiple ? (
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
          <button
            type="button"
            className="rounded-md px-2 py-1 text-[12px] font-semibold text-accent hover:bg-accent-subtle disabled:text-text-tertiary disabled:hover:bg-transparent"
            disabled={visibleSelected === visible.length || visible.length === 0}
            onClick={selectVisible}
          >
            {messages.transform.selectAllColumns}
          </button>
          <button
            type="button"
            className="rounded-md px-2 py-1 text-[12px] font-semibold text-text-secondary hover:bg-subtle disabled:text-text-tertiary disabled:hover:bg-transparent"
            disabled={visibleSelected === 0 || selectedCount <= minSelected}
            onClick={deselectVisible}
          >
            {messages.transform.deselectAllColumns}
          </button>
        </div>
      ) : null}
      <ul
        className={cn(
          "scroll-pane m-0 min-h-0 list-none overflow-y-auto p-0",
          fill ? "flex-1" : "max-h-72",
        )}
      >
        {visible.length === 0 ? (
          <li className="px-3 py-3 text-[13px] text-text-secondary">{messages.transform.noMatchingColumns}</li>
        ) : (
          visible.map((column) => {
            const active = selected.has(column.name);
            const extra = badge?.(column);
            return (
              <li key={column.name} className="border-b border-border/80 last:border-b-0">
                <label
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 px-3 py-2 select-none",
                    selectableClass(active),
                  )}
                  title={column.dtype ? `${column.name} (${column.dtype})` : column.name}
                >
                  <input
                    className="sr-only"
                    type={multiple ? "checkbox" : "radio"}
                    name={multiple ? undefined : groupId}
                    checked={active}
                    onChange={() => onToggle(column.name)}
                  />
                  <span
                    className={cn(
                      "grid size-4 shrink-0 place-items-center rounded border",
                      !multiple && "rounded-full",
                      active
                        ? "border-accent bg-accent text-white"
                        : "border-border-strong bg-surface text-transparent",
                    )}
                    aria-hidden="true"
                  >
                    <Check className="size-3" />
                  </span>
                  <span className="min-w-0 flex-1 overflow-hidden">
                    <span className="block truncate text-[13px] font-semibold text-text">{column.name}</span>
                    {extra ? (
                      <span className="mt-0.5 block truncate text-[12px] font-medium text-accent">{extra}</span>
                    ) : null}
                  </span>
                  {column.dtype ? (
                    <span className="shrink-0 rounded-md bg-subtle px-1.5 py-0.5 font-mono text-[10px] font-medium text-text-secondary">
                      {column.dtype}
                    </span>
                  ) : null}
                </label>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

export function ColumnChipPicker({
  columns,
  value,
  emptyLabel,
  onChange,
  minSelected = 1,
  fill = false,
  className,
}: {
  columns: DatasetColumn[];
  value: string[];
  emptyLabel: string;
  onChange: (columns: string[]) => void;
  minSelected?: number;
  fill?: boolean;
  className?: string;
}) {
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
    <ColumnPickerList
      columns={columns}
      emptyLabel={emptyLabel}
      selected={kept}
      multiple
      minSelected={minSelected}
      fill={fill}
      className={className}
      onToggle={toggle}
      onSetSelected={onChange}
    />
  );
}

export function ColumnChipSinglePicker({
  columns,
  value,
  emptyLabel,
  onChange,
  badge,
  fill = false,
  className,
}: {
  columns: DatasetColumn[];
  value: string;
  emptyLabel: string;
  onChange: (column: string) => void;
  badge?: (column: DatasetColumn) => string | null;
  fill?: boolean;
  className?: string;
}) {
  return (
    <ColumnPickerList
      columns={columns}
      emptyLabel={emptyLabel}
      selected={value ? new Set([value]) : new Set()}
      multiple={false}
      badge={badge}
      fill={fill}
      className={className}
      onToggle={onChange}
    />
  );
}

const STEP_PANE_HEIGHT = "h-[16.5rem]";
const FILTER_OP_GRID: FilterOp[] = [
  "contains",
  "not contains",
  "is null",
  "is not null",
  "=",
  "!=",
  ">",
  "<",
  ">=",
  "<=",
];

function StepPane({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.06em] text-text-tertiary">
        {label}
      </p>
      <div className={cn("flex min-h-0 flex-col", STEP_PANE_HEIGHT)}>{children}</div>
    </div>
  );
}

export function RenameStepFields({
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

export function CastStepFields({
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

export function SortStepFields({
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

export function keptColumnsForStep(
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

export function isColumnStepNoOp(
  step: Extract<TransformStep, { op: "select" } | { op: "drop" }>,
  columns: DatasetColumn[],
): boolean {
  const names = columns.map((column) => column.name);
  if (names.length === 0) return true;
  const kept = keptColumnsForStep(step, columns);
  return kept.length === names.length;
}

export function usableSteps(steps: TransformStep[], baseColumns: DatasetColumn[]): TransformStep[] {
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
      case "derive":
        if (step.name.trim() && step.expr.trim()) out.push(step);
        break;
      case "trim":
        if (step.columns.length > 0) out.push(step);
        break;
      case "replace":
        if (step.column.trim() && step.find.length > 0) out.push(step);
        break;
      case "split":
        if (step.column.trim() && step.delimiter.length > 0 && step.name.trim()) out.push(step);
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

export function specFrom(
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

export function parseFilterExpr(expr: string): { column: string; op: FilterOp; value: string } | null {
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

export function isNumericDtype(dtype?: string): boolean {
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

export function isStringDtype(dtype?: string): boolean {
  if (!dtype) return false;
  const d = dtype.toLowerCase();
  return d.includes("str") || d.includes("utf") || d.includes("string") || d.includes("categorical");
}

export function formatFilterValue(value: string, dtype?: string): string {
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

export function buildFilterExpr(column: string, op: FilterOp, value: string, dtype?: string): string {
  if (!column.trim()) return "";
  if (!filterOpNeedsValue(op)) return `${column.trim()} ${op}`;
  const rhs = formatFilterValue(
    value,
    op === "contains" || op === "not contains" ? "String" : dtype,
  );
  if (!rhs) return "";
  return `${column.trim()} ${op} ${rhs}`;
}

export function filterOpMeta(
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
    case "contains":
      return { label: messages.transform.filterOpContains, title: messages.transform.filterOpContains };
    case "not contains":
      return { label: messages.transform.filterOpNotContains, title: messages.transform.filterOpNotContains };
    case "is null":
      return { label: messages.transform.filterOpIsNull, title: messages.transform.filterOpIsNull };
    case "is not null":
      return { label: messages.transform.filterOpNotNull, title: messages.transform.filterOpNotNull };
  }
}

export function FilterStepFields({
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
    column && (!filterOpNeedsValue(op) || value.trim())
      ? messages.transform.filterPreview(column, op, filterOpNeedsValue(op) ? value.trim() : "")
      : null;

  return (
    <div className="grid items-start gap-3 min-[42rem]:grid-cols-3">
      <StepPane label={messages.common.columns}>
        <ColumnChipSinglePicker
          fill
          columns={columns}
          value={column}
          emptyLabel={messages.transform.noColumns}
          className="max-w-none"
          onChange={(name) => {
            setColumn(name);
            commit(name, op, value);
          }}
        />
      </StepPane>
      <StepPane label={messages.transform.filterOperators}>
        <div className="grid h-full min-h-0 grid-cols-2 grid-rows-5 gap-1.5 rounded-lg border border-border bg-surface p-1.5">
          {FILTER_OP_GRID.map((item) => {
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
                  "flex min-w-0 items-center justify-center rounded-md border px-2 text-center text-[12px] font-semibold leading-tight whitespace-nowrap transition-colors",
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
      </StepPane>
      <StepPane label={messages.transform.filterValueLabel}>
        <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-raised/40 p-3">
          {column ? (
            <>
              {filterOpNeedsValue(op) ? (
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
              ) : (
                <p className="text-[11px] leading-5 text-text-tertiary">
                  {messages.transform.filterNoValue}
                </p>
              )}
              {preview ? (
                <p className="mt-auto pt-3 font-mono text-[11px] leading-5 text-text-secondary">
                  {preview}
                </p>
              ) : null}
            </>
          ) : (
            <p className="m-auto max-w-[12rem] text-center text-[11px] leading-5 text-text-tertiary">
              {messages.transform.filterPickColumn}
            </p>
          )}
        </div>
      </StepPane>
    </div>
  );
}

function deriveOpMeta(
  op: DeriveOp,
  messages: ReturnType<typeof useLanguage>["messages"],
): { label: string; title: string } {
  switch (op) {
    case "+":
      return { label: "+", title: messages.transform.deriveOpAdd };
    case "-":
      return { label: "−", title: messages.transform.deriveOpSub };
    case "*":
      return { label: "×", title: messages.transform.deriveOpMul };
    case "/":
      return { label: "÷", title: messages.transform.deriveOpDiv };
  }
}

export function DeriveStepFields({
  step,
  columns,
  onChange,
  messages,
}: {
  step: Extract<TransformStep, { op: "derive" }>;
  columns: DatasetColumn[];
  onChange: (step: TransformStep) => void;
  messages: ReturnType<typeof useLanguage>["messages"];
}) {
  const parsed = useMemo(() => parseDeriveExpr(step.expr), [step.expr]);
  const [name, setName] = useState(step.name);
  const [left, setLeft] = useState(parsed?.left ?? "");
  const [op, setOp] = useState<DeriveOp>(parsed?.op ?? "+");
  const [right, setRight] = useState(parsed?.right ?? "");

  useEffect(() => {
    const next = parseDeriveExpr(step.expr);
    setName(step.name);
    setLeft(next?.left ?? "");
    setOp(next?.op ?? "+");
    setRight(next?.right ?? "");
  }, [step.expr, step.name]);

  function commit(nextName: string, nextLeft: string, nextOp: DeriveOp, nextRight: string) {
    const leftCol = nextLeft.trim();
    onChange({
      op: "derive",
      name: nextName.trim() || leftCol,
      expr: buildDeriveExpr(leftCol, nextOp, nextRight),
    });
  }

  if (columns.length === 0) {
    return <p className="text-xs text-text-tertiary">{messages.transform.noColumns}</p>;
  }

  const resultName = name.trim() || left;
  const preview =
    left && right.trim()
      ? messages.transform.derivePreview(resultName || left, left, op, right.trim())
      : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid items-start gap-3 min-[42rem]:grid-cols-3">
        <StepPane label={messages.transform.deriveLeftLabel}>
          <ColumnChipSinglePicker
            fill
            columns={columns}
            value={left}
            emptyLabel={messages.transform.noColumns}
            className="max-w-none"
            onChange={(item) => {
              const nextName = !name.trim() || name.trim() === left ? item : name;
              setLeft(item);
              setName(nextName);
              commit(nextName, item, op, right);
            }}
          />
        </StepPane>
        <StepPane label={messages.transform.deriveOperators}>
          <div className="grid h-full min-h-0 grid-cols-2 grid-rows-2 gap-1.5 rounded-lg border border-border bg-surface p-2">
            {DERIVE_OPS.map((item) => {
              const meta = deriveOpMeta(item, messages);
              const active = op === item;
              return (
                <button
                  key={item}
                  type="button"
                  title={meta.title}
                  aria-pressed={active}
                  onClick={() => {
                    setOp(item);
                    commit(name, left, item, right);
                  }}
                  className={cn(
                    "flex items-center justify-center rounded-md border text-lg font-semibold transition-colors",
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
        </StepPane>
        <StepPane label={messages.transform.deriveRightLabel}>
          <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-surface">
            <div className="shrink-0 border-b border-border p-2">
              <input
                className="field-control technical"
                value={right}
                placeholder={messages.transform.deriveRightPlaceholder}
                onChange={(event) => {
                  const next = event.target.value;
                  setRight(next);
                  commit(name, left, op, next);
                }}
              />
            </div>
            <div className="min-h-0 flex-1">
              <ColumnChipSinglePicker
                fill
                columns={columns}
                value={columns.some((item) => item.name === right) ? right : ""}
                emptyLabel={messages.transform.noColumns}
                className="h-full max-w-none rounded-none border-0"
                onChange={(item) => {
                  setRight(item);
                  commit(name, left, op, item);
                }}
              />
            </div>
          </div>
        </StepPane>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full max-w-xs">
          <FormField label={messages.transform.deriveResultName}>
            <input
              className="field-control"
              value={name}
              placeholder={left || messages.transform.deriveResultPlaceholder}
              onChange={(event) => {
                const next = event.target.value;
                setName(next);
                commit(next, left, op, right);
              }}
            />
          </FormField>
        </div>
        {preview ? (
          <p className="mb-1 font-mono text-[11px] leading-5 text-text-secondary">{preview}</p>
        ) : (
          <p className="mb-1 text-[11px] leading-5 text-text-tertiary">{messages.transform.derivePickColumn}</p>
        )}
      </div>
    </div>
  );
}


export function ReplaceStepFields({
  step,
  columns,
  onChange,
  messages,
}: {
  step: Extract<TransformStep, { op: "replace" }>;
  columns: DatasetColumn[];
  onChange: (step: TransformStep) => void;
  messages: ReturnType<typeof useLanguage>["messages"];
}) {
  if (columns.length === 0) {
    return <p className="text-xs text-text-tertiary">{messages.transform.noColumns}</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <ColumnChipSinglePicker
        columns={columns}
        value={step.column}
        emptyLabel={messages.transform.noColumns}
        onChange={(column) => onChange({ ...step, column })}
      />
      {step.column ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-raised/40 p-2.5">
          <FormField label={messages.transform.replaceFind}>
            <input
              className="field-control technical"
              value={step.find}
              placeholder={messages.transform.replaceFindPlaceholder}
              onChange={(event) => onChange({ ...step, find: event.target.value })}
            />
          </FormField>
          <FormField label={messages.transform.replaceWith}>
            <input
              className="field-control technical"
              value={step.replacement}
              placeholder={messages.transform.replaceWithPlaceholder}
              onChange={(event) => onChange({ ...step, replacement: event.target.value })}
            />
          </FormField>
        </div>
      ) : (
        <p className="text-[11px] text-text-tertiary">{messages.transform.pickColumn}</p>
      )}
    </div>
  );
}

export function SplitStepFields({
  step,
  columns,
  onChange,
  messages,
}: {
  step: Extract<TransformStep, { op: "split" }>;
  columns: DatasetColumn[];
  onChange: (step: TransformStep) => void;
  messages: ReturnType<typeof useLanguage>["messages"];
}) {
  if (columns.length === 0) {
    return <p className="text-xs text-text-tertiary">{messages.transform.noColumns}</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <ColumnChipSinglePicker
        columns={columns}
        value={step.column}
        emptyLabel={messages.transform.noColumns}
        onChange={(column) =>
          onChange({
            ...step,
            column,
            name: step.name.trim() && step.name !== step.column ? step.name : column,
          })
        }
      />
      {step.column ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-raised/40 p-2.5">
          <FormField label={messages.transform.splitDelimiter}>
            <input
              className="field-control technical"
              value={step.delimiter}
              placeholder={messages.transform.splitDelimiterPlaceholder}
              onChange={(event) => onChange({ ...step, delimiter: event.target.value })}
            />
          </FormField>
          <FormField label={messages.transform.splitIndex}>
            <input
              className="field-control technical"
              type="number"
              min={1}
              value={step.index + 1}
              onChange={(event) => {
                const next = Number.parseInt(event.target.value, 10);
                onChange({
                  ...step,
                  index: Number.isFinite(next) ? Math.max(0, next - 1) : 0,
                });
              }}
            />
          </FormField>
          <FormField label={messages.transform.splitName}>
            <input
              className="field-control"
              value={step.name}
              placeholder={step.column || messages.transform.splitNamePlaceholder}
              onChange={(event) => onChange({ ...step, name: event.target.value })}
            />
          </FormField>
        </div>
      ) : (
        <p className="text-[11px] text-text-tertiary">{messages.transform.pickColumn}</p>
      )}
    </div>
  );
}

export function PreviewGrid({
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


export function StepFields({
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
    case "derive":
      return (
        <DeriveStepFields
          step={step}
          columns={columns}
          onChange={onChange}
          messages={messages}
        />
      );
    case "trim":
      return (
        <ColumnChipPicker
          columns={columns}
          value={step.columns}
          emptyLabel={messages.transform.noColumns}
          minSelected={0}
          onChange={(next) => onChange({ ...step, columns: next })}
        />
      );
    case "replace":
      return (
        <ReplaceStepFields
          step={step}
          columns={columns}
          onChange={onChange}
          messages={messages}
        />
      );
    case "split":
      return (
        <SplitStepFields
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
