import type { Chip } from "@/types/chip";
import { storedDatasetId } from "@/features/workspace/workspaceCanvasModel";

export const DEFAULT_SCRIPT_MAIN = "function main(ctx) {\n  ctx.write(ctx.input() ?? []);\n}\n";
export const DEFAULT_SCRIPT_HELPER = "module.exports = {\n};\n";
export const SCRIPT_ENTRY = "main.js";
export const MAX_SCRIPT_FILES = 16;
export const MAX_SCRIPT_BYTES = 256 * 1024;
export const MAX_SCRIPT_INPUTS = 8;

export type ScriptInputRef = { name: string; dataset_id: string };

export function defaultScriptName(sourceName: string): string {
  const trimmed = sourceName.trim();
  if (!trimmed) return trimmed;
  const chained = /^script-(?:(\d+)-)?(.+)$/i.exec(trimmed);
  if (chained) {
    const sequence = chained[1] ? Number.parseInt(chained[1], 10) + 1 : 2;
    return `script-${String(sequence).padStart(2, "0")}-${chained[2]}`;
  }
  return `script-${trimmed}`;
}

export function outputFilenameFromChip(chip: Chip | null): string {
  const value = chip?.config?.output_filename;
  return typeof value === "string" ? value.trim() : "";
}

export function validScriptFileName(name: string) {
  return /^[A-Za-z0-9._-]+\.js$/.test(name) && !name.startsWith(".");
}

export function filesFromChip(chip: Chip | null): Record<string, string> {
  const config = chip?.config ?? {};
  const files: Record<string, string> = {};
  if (config.files && typeof config.files === "object" && !Array.isArray(config.files)) {
    for (const [name, source] of Object.entries(config.files as Record<string, unknown>)) {
      if (typeof source === "string") files[name] = source;
    }
  }
  if (!files[SCRIPT_ENTRY]) files[SCRIPT_ENTRY] = DEFAULT_SCRIPT_MAIN;
  return files;
}

export function scriptBytes(files: Record<string, string>) {
  return Object.values(files).reduce((total, source) => total + source.length, 0);
}

export function inputNameFromLabel(label: string) {
  const trimmed = label.trim();
  const stem = trimmed.replace(/\.(parquet|csv|json|tsv)$/i, "").trim();
  return stem || "input";
}

export function uniqueInputName(label: string, used: Iterable<string>) {
  const taken = new Set(used);
  const base = inputNameFromLabel(label);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

export function inputsFromChip(chip: Chip | null): ScriptInputRef[] {
  const config = chip?.config ?? {};
  const out: ScriptInputRef[] = [];
  const used = new Set<string>();
  if (Array.isArray(config.inputs)) {
    for (const item of config.inputs) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      const datasetId = typeof row.dataset_id === "string" ? storedDatasetId(row.dataset_id) : "";
      if (!datasetId) continue;
      const name = uniqueInputName(typeof row.name === "string" ? row.name : "input", used);
      used.add(name);
      out.push({ name, dataset_id: datasetId });
    }
  }
  if (out.length === 0) {
    const datasetId = typeof config.input_dataset_id === "string" ? storedDatasetId(config.input_dataset_id) : "";
    if (datasetId) out.push({ name: "input", dataset_id: datasetId });
  }
  return out.slice(0, MAX_SCRIPT_INPUTS);
}

console.assert(defaultScriptName("orders.csv") === "script-orders.csv", "script name: prefix source");
console.assert(defaultScriptName("script-orders.csv") === "script-02-orders.csv", "script name: bump chain");
console.assert(defaultScriptName("script-02-orders.csv") === "script-03-orders.csv", "script name: increment");
console.assert(inputNameFromLabel("orders.parquet") === "orders", "script input: strip parquet");
console.assert(uniqueInputName("orders", ["orders"]) === "orders_2", "script input: uniquify");
