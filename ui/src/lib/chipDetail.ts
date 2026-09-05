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

export type LoadConfigView = {
  destinationType: "database" | "file";
  connectionId: string;
  table: string;
  format: string;
  filename: string;
  writeMode: string;
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
  const legacySteps = Array.isArray(spec.steps)
    ? spec.steps.filter(isTransformStep)
    : [];
  const cleanOperation = Array.isArray(spec.operations)
    ? spec.operations.find(
        (operation) =>
          operation != null
          && typeof operation === "object"
          && !Array.isArray(operation)
          && (operation as { type?: unknown }).type === "clean",
      )
    : undefined;
  const operationSteps =
    cleanOperation != null
    && typeof cleanOperation === "object"
    && !Array.isArray(cleanOperation)
    && Array.isArray((cleanOperation as { steps?: unknown }).steps)
      ? (cleanOperation as { steps: unknown[] }).steps.filter(isTransformStep)
      : [];
  return {
    inputDatasetId: textValue(config, "input_dataset_id"),
    steps: cleanOperation === undefined ? legacySteps : operationSteps,
  };
}

export function parseLoadConfig(config: ChipConfig): LoadConfigView | null {
  const destination = objectValue(config, "destination");
  const type = textValue(destination, "type");
  if (type !== "database" && type !== "file") return null;
  return {
    destinationType: type,
    connectionId: textValue(destination, "connection_id"),
    table: textValue(destination, "table"),
    format: textValue(destination, "format"),
    filename: textValue(destination, "filename"),
    writeMode: textValue(config, "write_mode", "append"),
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
    chips: { bindingExtract: string; bindingTransform: string; bindingLoad: string };
  },
): string {
  if (refKind === "extract_definition") return messages.chips.bindingExtract;
  if (refKind === "transform") return messages.chips.bindingTransform;
  if (refKind === "load_definition") return messages.chips.bindingLoad;
  return refKind;
}

export function supportsReadableDetail(kind: ChipKind): boolean {
  return kind === "extract" || kind === "transform" || kind === "load";
}
