import { ReactNode } from "react";
import { NavIcon, type NavIconName } from "@/components/ui/nav-icons";
import { cn } from "@/lib/cn";

export function PageShell({
  children,
  className,
  fill = false,
}: {
  children: ReactNode;
  className?: string;
  fill?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3",
        fill ? "min-h-0 flex-1 overflow-hidden" : undefined,
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  icon,
  iconName,
}: {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: ReactNode;
  icon?: ReactNode;
  iconName?: NavIconName;
}) {
  return (
    <div className="mb-3 shrink-0">
      <header className="relative overflow-hidden rounded-xl border border-accent/15 bg-gradient-to-r from-surface from-[12%] to-accent-subtle px-5 py-2.5 shadow-[0_10px_28px_rgba(23,105,194,0.08)]">
        <div className="pointer-events-none absolute -right-10 -top-12 size-40 rounded-full bg-accent/20 blur-2xl" />
        <div className="pointer-events-none absolute right-16 -bottom-16 size-28 rounded-full bg-surface/70 blur-xl" />
        <div className="relative flex items-center justify-between gap-6">
          <div className="flex min-w-0 items-center gap-3.5">
            <span className="flex h-8 w-10 shrink-0 items-center border-r border-border pr-3 text-text">
              {icon ?? <NavIcon name={iconName ?? "overview"} className="size-[22px]" />}
            </span>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold tracking-[-0.015em] text-text">{title}</h1>
              {description ? (
                <p className="mt-0.5 max-w-3xl truncate text-[12px] text-text-secondary">{description}</p>
              ) : null}
            </div>
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
        </div>
      </header>
      <div className="page-section-rule" aria-hidden="true" />
    </div>
  );
}
