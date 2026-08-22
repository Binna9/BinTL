import { cn } from "@/lib/cn";

export function TableChip({
  label,
  on,
  onClick,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-7 border-l-2 px-2.5 text-left font-mono text-xs",
        on
          ? "border-accent bg-accent-subtle text-accent"
          : "border-transparent text-text-secondary hover:bg-subtle hover:text-text",
      )}
    >
      {label}
    </button>
  );
}
