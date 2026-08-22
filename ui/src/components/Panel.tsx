import { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Panel({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <section
      {...props}
      className={cn("border border-border bg-surface", className)}
    >
      {children}
    </section>
  );
}

export function PanelHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex min-h-11 items-center justify-between gap-4 border-b border-border px-4 py-2.5">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-text">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-xs text-text-secondary">{description}</p>
        ) : null}
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
