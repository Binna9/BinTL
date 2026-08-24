export function LiveDot({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
      <span className="size-1.5 rounded-full bg-success" />
      {label}
    </span>
  );
}
