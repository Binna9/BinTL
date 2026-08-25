import { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function FormField({
  label,
  example,
  hint,
  wide,
  children,
}: {
  label: string;
  example?: string;
  hint?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", wide && "md:col-span-2")}>
      <span className="flex min-h-4 min-w-0 items-baseline justify-between gap-2">
        <span className="shrink-0 text-xs font-medium text-text-secondary">{label}</span>
        {example ? (
          <span className="min-w-0 truncate text-right text-[11px] text-text-tertiary">
            {example}
          </span>
        ) : null}
      </span>
      {children}
      {hint ? (
        <span className="text-[11px] leading-4 text-text-tertiary">{hint}</span>
      ) : null}
    </div>
  );
}
