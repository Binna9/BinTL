import { cn } from "@/lib/cn";

export function ColumnChips({
  choices,
  selected,
  disabledNames = [],
  empty,
  busy = false,
  disabled = false,
  onToggle,
}: {
  choices: string[];
  selected: string[];
  disabledNames?: string[];
  empty: string;
  busy?: boolean;
  disabled?: boolean;
  onToggle: (name: string) => void;
}) {
  const vacant = busy || choices.length === 0;
  return (
    <div
      className={cn(
        "flex min-h-10 rounded-lg border p-2",
        vacant
          ? "items-center border-dashed border-border bg-subtle/50 px-3"
          : "flex-wrap gap-2 border-border bg-surface",
      )}
    >
      {vacant ? (
        <p className="text-xs text-text-tertiary">{empty}</p>
      ) : choices.map((name) => {
        const on = selected.includes(name);
        const locked = disabled || disabledNames.includes(name);
        return (
          <button
            key={name}
            type="button"
            disabled={locked}
            className={cn(
              "rounded-md border px-2 py-1 text-xs transition-colors",
              locked && !on
                ? "cursor-not-allowed border-border text-text-tertiary"
                : on
                  ? "border-accent bg-accent-subtle font-semibold text-accent"
                  : "border-border text-text-secondary hover:border-accent/50 hover:bg-subtle",
            )}
            onClick={() => onToggle(name)}
          >
            {name}
          </button>
        );
      })}
    </div>
  );
}
