export const DELIMITER_VALUES = [",", "|", ";", "tab", "^", ":", " "] as const;

/** Field separator used by source `.dat` files. Not a single character. */
export const COLON_PIPE_DELIMITER = ":||";

export function isValidDelimiter(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === "tab" || trimmed === "\\t" || trimmed === COLON_PIPE_DELIMITER) return true;
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
