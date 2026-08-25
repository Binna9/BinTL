import { PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/cn";

export function ResizeGrip({
  label,
  onPointerDown,
  onDoubleClick,
  className,
}: {
  label: string;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onDoubleClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        "absolute bottom-0.5 right-0.5 z-10 grid size-5 cursor-se-resize place-items-center rounded-sm text-text-tertiary outline-none hover:bg-subtle hover:text-text focus-visible:ring-2 focus-visible:ring-accent/40",
        className,
      )}
      aria-label={label}
      title={label}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path
          d="M5 11h6V5M8 11h3V8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        />
      </svg>
    </button>
  );
}
