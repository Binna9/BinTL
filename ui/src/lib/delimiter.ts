export const DELIMITER_VALUES = [",", "|", ";", "tab", "^", ":", " "] as const;

export function isValidDelimiter(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === "tab" || trimmed === "\\t") return true;
  if (trimmed.length === 1) return trimmed.charCodeAt(0) < 128;
  return raw.length === 1 && raw.charCodeAt(0) < 128;
}

/** Normalize a stored delimiter so the editor select can show it. */
export function displayDelimiter(raw?: string | null): string {
  const value = raw?.trim() ?? "";
  if (!value) return ",";
  if (value === "\t" || value === "\\t") return "tab";
  return value;
}
