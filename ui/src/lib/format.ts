import type { Messages } from "@/i18n/ko";

export function fmtSqlPreview(sql: string | null | undefined): string {
  if (!sql) return "";
  const line = sql.replace(/\s+/g, " ").trim();
  return line.length > 72 ? `${line.slice(0, 72)}…` : line;
}

export function fmtDelimiterGlyph(raw: string, messages: Messages): string {
  if (raw === "tab" || raw === "\\t" || raw === "\t") return "TAB";
  if (raw === " ") return messages.format.space;
  return raw;
}

export function fmtDelimiter(raw: string, messages: Messages): string {
  const glyph = fmtDelimiterGlyph(raw, messages);
  return glyph === "TAB" || glyph === messages.format.space
    ? glyph
    : messages.format.delimiter(raw);
}

export function fmtWhen(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z").slice(0, 19);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
