import type { Chip } from "@/types/chip";

export function nextSequencedChipName(
  chips: Chip[],
  formatName: (index: number) => string,
  include: (chip: Chip) => boolean,
): string {
  const template = formatName(0);
  const placeholder = template.match(/^(.*?)(0+)(\D*)$/);
  const prefix = placeholder?.[1] ?? template;
  const suffix = placeholder?.[3] ?? "";
  const normalizedPrefix = prefix.replace(/[\s_-]+/g, "").toLocaleLowerCase();
  let highest = 0;
  for (const chip of chips) {
    if (!include(chip)) continue;
    const candidate = chip.name.match(/^(.*?)(\d+)(\D*)$/);
    if (!candidate) continue;
    const candidatePrefix = candidate[1].replace(/[\s_-]+/g, "").toLocaleLowerCase();
    if (candidatePrefix !== normalizedPrefix || candidate[3] !== suffix) continue;
    highest = Math.max(highest, Number(candidate[2]));
  }
  return formatName(highest + 1);
}

export function extractSourceType(chip: Chip): string | undefined {
  const source = chip.config.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  const type = (source as Record<string, unknown>).type;
  return typeof type === "string" ? type : undefined;
}
