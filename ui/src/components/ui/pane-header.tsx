import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function PaneHeader({
  title,
  meta,
  description,
  actions,
  className,
}: {
  title: string;
  meta?: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-3",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
        <span className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-text">
          {title}
        </span>
        {meta ? (
          <span className="shrink-0 rounded-full border border-border bg-surface px-1.5 py-0.5 text-[10px] tabular-nums text-text-tertiary">
            {meta}
          </span>
        ) : null}
        {description ? (
          <span className="truncate text-[11px] text-text-tertiary">{description}</span>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </header>
  );
}
