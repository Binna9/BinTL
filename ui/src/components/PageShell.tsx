import { ReactNode } from "react";

export function PageShell({ children }: { children: ReactNode }) {
  return <div className="flex min-h-full flex-col gap-4">{children}</div>;
}

export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
}: {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex min-h-16 items-end justify-between gap-6 border-b border-border pb-3">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-text">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-3xl text-[13px] text-text-secondary">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </header>
  );
}
