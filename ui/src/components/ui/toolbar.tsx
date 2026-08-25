import { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Toolbar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-3 py-1.5",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function ToolbarGroup({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-1.5">{children}</div>;
}
