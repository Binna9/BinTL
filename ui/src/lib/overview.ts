import type { ChipKind } from "@/types/chip";

export type DayPoint = {
  key: string;
  label: string;
  extract: number;
  transform: number;
  load: number;
  sql: number;
  validation: number;
  serve: number;
  script: number;
};

function atMs(iso: string) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function startOfDay(date: Date) {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}

export function dayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function parseDay(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

export const TREND_MAX_SPAN_DAYS = 30;

export function shiftDay(key: string, days: number) {
  const day = parseDay(key);
  day.setDate(day.getDate() + days);
  return dayKey(day);
}

export function clampTrendRange(from: string, to: string, today = dayKey(new Date())) {
  let end = to > today ? today : to;
  let start = from > end ? end : from;
  const earliest = shiftDay(end, -TREND_MAX_SPAN_DAYS);
  if (start < earliest) start = earliest;
  const latest = shiftDay(start, TREND_MAX_SPAN_DAYS);
  if (end > latest) end = latest > today ? today : latest;
  return { from: start, to: end };
}

export function bucketActivity(
  runs: { kind: ChipKind; created_at: string }[],
  range: Date | { from: Date; to: Date } = new Date(),
): DayPoint[] {
  const end = startOfDay(range instanceof Date ? range : range.to);
  const start = startOfDay(
    range instanceof Date ? new Date(end.getFullYear(), end.getMonth(), end.getDate() - 6) : range.from,
  );
  const from = start <= end ? start : end;
  const to = start <= end ? end : start;
  const days: DayPoint[] = [];
  for (const cursor = new Date(from); cursor.getTime() <= to.getTime(); cursor.setDate(cursor.getDate() + 1)) {
    const day = new Date(cursor);
    const next = new Date(day);
    next.setDate(day.getDate() + 1);
    const rows = runs.filter((run) => {
      const t = atMs(run.created_at);
      return t != null && t >= day.getTime() && t < next.getTime();
    });
    days.push({
      key: dayKey(day),
      label: `${day.getMonth() + 1}/${day.getDate()}`,
      extract: rows.filter((run) => run.kind === "extract").length,
      transform: rows.filter((run) => run.kind === "transform").length,
      load: rows.filter((run) => run.kind === "load").length,
      sql: rows.filter((run) => run.kind === "sql").length,
      validation: rows.filter((run) => run.kind === "validation").length,
      serve: rows.filter((run) => run.kind === "serve").length,
      script: rows.filter((run) => run.kind === "script").length,
    });
  }
  return days;
}

export function successRate(rows: { status: string }[]) {
  if (!rows.length) return null;
  return Math.round(
    (rows.filter((row) => row.status === "succeeded").length / rows.length) * 100,
  );
}

export function sharePercent(count: number, total: number) {
  if (!total) return 0;
  return Math.round((count / total) * 100);
}

export function fileName(path: string) {
  return path.split(/[/\\]/).pop() || path;
}

if (import.meta.env.DEV) {
  const now = new Date(2026, 7, 26, 12, 0, 0);
  const days = bucketActivity(
    [
      { kind: "extract", created_at: new Date(2026, 7, 26, 3, 0, 0).toISOString() },
      { kind: "extract", created_at: new Date(2026, 7, 20, 9, 0, 0).toISOString() },
      { kind: "transform", created_at: new Date(2026, 7, 25, 18, 0, 0).toISOString() },
      { kind: "load", created_at: new Date(2026, 7, 26, 4, 0, 0).toISOString() },
      { kind: "sql", created_at: new Date(2026, 7, 26, 5, 0, 0).toISOString() },
    ],
    now,
  );
  if (days.length !== 7 || days[0].extract !== 1 || days[5].transform !== 1 || days[6].sql !== 1) {
    throw new Error("overview: 7-day chip buckets");
  }
  const picked = bucketActivity(
    [{ kind: "extract", created_at: new Date(2026, 7, 20, 9, 0, 0).toISOString() }],
    { from: new Date(2026, 7, 20), to: new Date(2026, 7, 20) },
  );
  if (picked.length !== 1 || picked[0].extract !== 1) {
    throw new Error("overview: picked-day chip buckets");
  }
  const clamped = clampTrendRange("2026-01-01", "2026-03-01", "2026-03-01");
  if (clamped.from !== "2026-01-30" || clamped.to !== "2026-03-01") {
    throw new Error("overview: trend range must stay within one month");
  }
  if (successRate([{ status: "succeeded" }, { status: "failed" }]) !== 50) {
    throw new Error("overview: success rate");
  }
  if (sharePercent(1, 4) !== 25 || sharePercent(0, 0) !== 0) {
    throw new Error("overview: share percent");
  }
}
