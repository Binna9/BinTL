import { cn } from "@/lib/cn";

export function LiveTicker({
  items,
  active,
}: {
  items: string[];
  active?: boolean;
}) {
  const visible = items.filter(Boolean);
  const latest = visible[visible.length - 1] ?? "";
  const joined = visible.join("    ·    ");
  if (!joined) {
    return <div className="min-h-5 min-w-0 flex-1" />;
  }
  const looping = Boolean(active && joined.length > 24);
  const unit = `${joined}    ·    `;
  const track = looping ? `${unit}${unit}` : latest;

  return (
    <div
      className="query-ticker min-w-0 flex-1"
      title={latest}
    >
      <div
        className={cn(
          "query-ticker-track technical text-[12px] text-text-secondary",
          looping && "is-running",
        )}
      >
        {track}
      </div>
    </div>
  );
}
