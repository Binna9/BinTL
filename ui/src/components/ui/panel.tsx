import { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { layout } from "@/lib/layout";

export function Panel({
  children,
  className,
  tall = false,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode; tall?: boolean }) {
  return (
    <section
      {...props}
      className={cn(
        "overflow-hidden rounded-xl bg-surface shadow-[0_1px_3px_rgba(15,23,42,0.045)] dark:border dark:border-white/15 dark:shadow-[0_2px_8px_rgba(0,0,0,0.16)]",
        tall && "flex flex-col",
        className,
      )}
      style={
        tall
          ? {
              minHeight: layout.page.workspaceHeight,
              height: layout.page.workspaceHeight,
              ...style,
            }
          : style
      }
    >
      {children}
    </section>
  );
}

export function PanelHeader({
  title,
  description,
  actions,
  icon,
  className,
  onPointerDown,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
  onPointerDown?: HTMLAttributes<HTMLElement>["onPointerDown"];
}) {
  return (
    <header
      className={cn(
        "flex min-h-11 items-center justify-between gap-4 rounded-t-xl border-b border-border bg-surface px-4 py-2.5",
        className,
      )}
      onPointerDown={onPointerDown}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {icon ? (
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent-subtle text-accent">
            {icon}
          </span>
        ) : null}
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text">{title}</h2>
          {description ? (
            <p className="mt-0.5 truncate text-xs text-text-secondary" title={description}>
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </header>
  );
}

export function PanelBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("p-4", className)}>{children}</div>;
}
