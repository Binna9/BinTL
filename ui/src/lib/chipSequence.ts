import type { Chip } from "@/types/chip";

export function nextSequencedChipName(
  chips: Chip[],
  formatName: (index: number) => string,
  include: (chip: Chip) => boolean,
): string {
  const marker = "__INDEX__";
  const template = formatName(0).replace(/0(?!.*0)/, marker);
  const [prefix = "", suffix = ""] = template.split(marker);
  let highest = 0;
  for (const chip of chips) {
    if (!include(chip) || !chip.name.startsWith(prefix) || !chip.name.endsWith(suffix)) continue;
    const numberPart = chip.name.slice(prefix.length, suffix ? -suffix.length : undefined).trim();
    if (/^\d+$/.test(numberPart)) highest = Math.max(highest, Number(numberPart));
  }
  return formatName(highest + 1);
}

export function extractSourceType(chip: Chip): string | undefined {
  const source = chip.config.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  const type = (source as Record<string, unknown>).type;
  return typeof type === "string" ? type : undefined;
}
