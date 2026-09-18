import type { Chip } from "@/types/chip";

export const DEFAULT_SCRIPT_MAIN = "function main(ctx) {\n  ctx.write(ctx.input() ?? []);\n}\n";
export const DEFAULT_SCRIPT_HELPER = "module.exports = {\n};\n";
export const SCRIPT_ENTRY = "main.js";
export const MAX_SCRIPT_FILES = 16;
export const MAX_SCRIPT_BYTES = 256 * 1024;

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

console.assert(defaultScriptName("orders.csv") === "script-orders.csv", "script name: prefix source");
console.assert(defaultScriptName("script-orders.csv") === "script-02-orders.csv", "script name: bump chain");
console.assert(defaultScriptName("script-02-orders.csv") === "script-03-orders.csv", "script name: increment");
