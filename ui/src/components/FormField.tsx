import { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function FormField({
  label,
  wide,
  children,
}: {
  label: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={cn("flex flex-col gap-1", wide && "md:col-span-2")}>
      <span className="text-xs font-medium text-text-secondary">{label}</span>
      {children}
    </label>
  );
}
