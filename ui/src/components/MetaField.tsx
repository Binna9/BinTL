import { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function MetaField({
  label,
  children,
  technical,
}: {
  label: string;
  children: ReactNode;
  technical?: boolean;
}) {
  return (
    <div className="min-w-24 shrink-0 overflow-hidden border-r border-border pr-4 last:border-r-0">
      <div className="text-[10px] font-medium leading-none text-text-tertiary">{label}</div>
      <div className={cn("mt-1 truncate text-[12px] leading-tight text-text", technical && "technical")}>
        {children}
      </div>
    </div>
  );
}
