import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { columnWidthsForContent, DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Select } from "@/components/ui/select";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import type { Dataset, DatasetColumn, FramePreview } from "@/types/dataset";
import type { TransformSpecV2, TransformStep } from "@/types/transform";
import { CAST_TYPES, FILTER_OPS, resolveColumnsAtStep, type FilterOp } from "@/features/transform/transformEditorModel";

export function ColumnChipPicker({
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

export function ColumnChipSinglePicker({
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
  const rhs = formatFilterValue(value, dtype);
  if (!column.trim() || !rhs) return "";
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
