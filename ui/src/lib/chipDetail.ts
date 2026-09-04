import type { ChipConfig, ChipKind } from "@/types/chip";
import type { TransformStep } from "@/types/transform";

export type ExtractConfigView = {
  connectionId: string;
  mode: "table" | "query" | "http";
  database: string;
  table: string;
  sql: string;
  method: string;
  path: string;
  recordsPath: string;
  delimiter: string;
  header: boolean;
};

export type TransformConfigView = {
  inputDatasetId: string;
  steps: TransformStep[];
};

function textValue(config: ChipConfig, key: string, fallback = ""): string {
  return typeof config[key] === "string" ? (config[key] as string) : fallback;
}

function boolValue(config: ChipConfig, key: string, fallback: boolean): boolean {
  return typeof config[key] === "boolean" ? (config[key] as boolean) : fallback;
}

function objectValue(config: ChipConfig, key: string): ChipConfig {
  const value = config[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ChipConfig) : {};
}

function isTransformStep(value: unknown): value is TransformStep {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const op = (value as { op?: unknown }).op;
  return typeof op === "string";
}

export function parseExtractConfig(config: ChipConfig): ExtractConfigView | null {
  const source = objectValue(config, "source");
  const sourceType = textValue(source, "type");
  const mode = sourceType === "http" ? "http" : sourceType === "query" ? "query" : "table";
  return {
    connectionId: textValue(config, "connection_id"),
    mode,
    database: textValue(source, "database"),
    table: textValue(source, "table"),
    sql: textValue(source, "sql"),
    method: textValue(source, "method", "GET"),
    path: textValue(source, "path"),
    recordsPath: textValue(source, "records_path"),
    delimiter: textValue(config, "delimiter", ","),
    header: boolValue(config, "header", true),
  };
}

export function parseTransformConfig(config: ChipConfig): TransformConfigView | null {
  const spec = objectValue(config, "spec");
  const rawSteps = spec.steps;
  const steps = Array.isArray(rawSteps) ? rawSteps.filter(isTransformStep) : [];
  return {
    inputDatasetId: textValue(config, "input_dataset_id"),
    steps,
  };
}

export function formatTransformStepSummary(step: TransformStep): string {
  switch (step.op) {
    case "select":
      return step.columns.length > 0 ? step.columns.join(", ") : "—";
    case "drop":
      return step.columns.length > 0 ? step.columns.join(", ") : "—";
    case "rename":
      return Object.entries(step.map)
        .map(([from, to]) => `${from} → ${to}`)
        .join(", ") || "—";
    case "filter":
      return step.expr.trim() || "—";
    case "cast":
      return Object.entries(step.columns)
        .map(([column, type]) => `${column}: ${type}`)
        .join(", ") || "—";
    case "fill_null":
      return step.columns.length > 0
        ? `${step.columns.join(", ")} = ${step.value}`
        : step.value;
    case "sort":
      return step.by
        .map((item) => `${item.column}${item.descending ? " ↓" : " ↑"}`)
        .join(", ") || "—";
    case "unique": {
      const subset = step.subset?.length ? step.subset.join(", ") : "—";
      return step.keep ? `${subset} · ${step.keep}` : subset;
    }
    default:
      return "—";
  }
}

export function bindingKindLabel(
  refKind: string,
  messages: {
    chips: { bindingExtract: string; bindingTransform: string };
  },
): string {
  if (refKind === "extract_definition") return messages.chips.bindingExtract;
  if (refKind === "transform") return messages.chips.bindingTransform;
  return refKind;
}

export function supportsReadableDetail(kind: ChipKind): boolean {
  return kind === "extract" || kind === "transform";
}
