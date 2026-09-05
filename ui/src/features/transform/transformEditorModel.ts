import { ArrowUpDown, Braces, Columns3, CopyMinus, Database, FileOutput, Filter, Replace, TextCursorInput, Type, Upload, type LucideIcon } from "lucide-react";
import type { Dataset, DatasetColumn } from "@/types/dataset";
import type { ChipInputSlotResponse } from "@/types/chip";
import type { StepOp, TransformStep } from "@/types/transform";

export function defaultTransformName(sourceName: string): string {
  const trimmed = sourceName.trim();
  if (!trimmed) return trimmed;
  const chained = /^transform-(?:(\d+)-)?(.+)$/i.exec(trimmed);
  if (chained) {
    const sequence = chained[1] ? Number.parseInt(chained[1], 10) + 1 : 2;
    return `transform-${String(sequence).padStart(2, "0")}-${chained[2]}`;
  }
  return `transform-${trimmed}`;
}

export function normalizeSlotColumns(
  columns: { name: string; dtype?: string; type?: string }[] | undefined,
): DatasetColumn[] {
  if (!columns) return [];
  return columns.map((column) => ({
    name: column.name,
    dtype: column.dtype ?? column.type ?? "String",
  }));
}

export function datasetFromSlot(slot: ChipInputSlotResponse): Dataset | null {
  if (slot.mode === "materialized" && slot.dataset) {
    const dataset = slot.dataset as unknown as Dataset;
    return dataset;
  }
  if (slot.mode === "planned" && slot.planned) {
    const raw = slot.dataset as Dataset | undefined;
    if (!raw) {
      return {
        id: slot.planned.dataset_id,
        kind: slot.planned.kind ?? (slot.source_chip_kind === "transform" ? "transform" : "database"),
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
      filename: slot.source_chip_kind === "transform" && slot.source_chip_name
        ? slot.source_chip_name
        : raw.filename,
      status: raw.status ?? "planned",
      columns: raw.columns?.length
        ? raw.columns
        : normalizeSlotColumns(slot.planned.columns),
      available: false,
    };
  }
  return null;
}

export const STEP_OPS: StepOp[] = [
  "select",
  "filter",
  "cast",
  "fill_null",
  "sort",
  "unique",
  "rename",
];

export const STEP_OP_ICONS: Record<StepOp, LucideIcon> = {
  select: Columns3,
  drop: Columns3,
  rename: TextCursorInput,
  filter: Filter,
  cast: Type,
  fill_null: Replace,
  sort: ArrowUpDown,
  unique: CopyMinus,
};

export const CAST_TYPES = ["Int64", "Int32", "Float64", "Float32", "String", "Boolean"];
export const FILTER_OPS = [">=", "<=", "!=", "=", ">", "<"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export const KIND_ORDER = ["upload", "database", "api", "transform"] as const;
export const KIND_APPEARANCE = {
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

export function emptyStep(op: StepOp): TransformStep {
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

export function resolveColumnsAtStep(
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
