import { ReactNode } from "react";
import { NavIcon, type NavIconName } from "@/components/NavIcons";

export function PageShell({ children }: { children: ReactNode }) {
  return <div className="flex min-h-full flex-col gap-4">{children}</div>;
}

export function PageHeader({
  title,
  description,
  eyebrow,
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
    <header className="relative overflow-hidden rounded-xl border border-accent/15 bg-gradient-to-r from-white from-[12%] to-accent-subtle px-5 py-4 shadow-[0_10px_28px_rgba(23,105,194,0.08)]">
      <div className="pointer-events-none absolute -right-10 -top-12 size-40 rounded-full bg-accent/20 blur-2xl" />
      <div className="pointer-events-none absolute right-16 -bottom-16 size-28 rounded-full bg-white/70 blur-xl" />
      <div className="relative flex items-end justify-between gap-6">
        <div className="flex min-w-0 items-center gap-3.5">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-white shadow-[0_8px_18px_rgba(23,105,194,0.32)]">
            {icon ?? <NavIcon name={iconName ?? "overview"} className="size-[18px]" />}
          </span>
          <div className="min-w-0">
            {eyebrow ? (
              <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-accent/80">
                {eyebrow}
              </p>
            ) : null}
            <h1 className="text-xl font-semibold tracking-[-0.015em] text-text">{title}</h1>
            {description ? (
              <p className="mt-1 max-w-3xl text-[13px] text-text-secondary">{description}</p>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </div>
    </header>
  );
}
