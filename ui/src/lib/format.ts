export function fmtWhen(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z").slice(0, 19);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
