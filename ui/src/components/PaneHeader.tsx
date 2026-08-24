export function PaneHeader({
  title,
  meta,
}: {
  title: string;
  meta?: string;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border bg-subtle px-3">
      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-secondary">
        {title}
      </span>
      {meta ? <span className="text-[11px] tabular-nums text-text-tertiary">{meta}</span> : null}
    </div>
  );
}
