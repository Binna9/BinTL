export type DayPoint = {
  key: string;
  label: string;
  extract: number;
  transform: number;
  load: number;
};

export function bucketActivity(
  extracts: { created_at: string }[],
  jobs: { created_at: string }[],
  now = new Date(),
): DayPoint[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(start);
    day.setDate(start.getDate() - (6 - i));
    const next = new Date(day);
    next.setDate(day.getDate() + 1);
    const inDay = (iso: string) => {
      const t = new Date(iso).getTime();
      return t >= day.getTime() && t < next.getTime();
    };
    return {
      key: `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`,
      label: `${day.getMonth() + 1}/${day.getDate()}`,
      extract: extracts.filter((row) => inDay(row.created_at)).length,
      transform: jobs.filter((row) => inDay(row.created_at)).length,
      load: 0,
    };
  });
}

export function successRate(rows: { status: string }[]) {
  if (!rows.length) return null;
  return Math.round(
    (rows.filter((row) => row.status === "succeeded").length / rows.length) * 100,
  );
}

export function fileName(path: string) {
  return path.split(/[/\\]/).pop() || path;
}

if (import.meta.env.DEV) {
  const now = new Date(2026, 7, 26, 12, 0, 0);
  const days = bucketActivity(
    [
      { created_at: new Date(2026, 7, 26, 3, 0, 0).toISOString() },
      { created_at: new Date(2026, 7, 20, 9, 0, 0).toISOString() },
    ],
    [{ created_at: new Date(2026, 7, 25, 18, 0, 0).toISOString() }],
    now,
  );
  console.assert(days.length === 7, "overview: 7 day buckets");
  console.assert(days[0].extract === 1, "overview: first-day extract");
  console.assert(days[5].transform === 1, "overview: yesterday transform");
  console.assert(days[6].extract === 1, "overview: today extract");
  console.assert(successRate([{ status: "succeeded" }, { status: "failed" }]) === 50);
}
