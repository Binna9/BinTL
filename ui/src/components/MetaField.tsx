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
    <div className="min-w-28 border-r border-border pr-5 last:border-r-0">
      <div className="text-[11px] font-medium text-text-tertiary">{label}</div>
      <div className={cn("mt-1 text-[13px] text-text", technical && "technical")}>
        {children}
      </div>
    </div>
  );
}
