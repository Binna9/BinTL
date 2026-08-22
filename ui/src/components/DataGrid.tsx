import { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function DataGrid({
  headers,
  children,
  className,
}: {
  headers: string[];
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("overflow-auto", className)}>
      <table className="w-full border-collapse text-[13px]">
        <thead className="sticky top-0 z-10">
          <tr>
            {headers.map((h) => (
              <th
                key={h}
                className="h-8 whitespace-nowrap border-b border-border bg-raised px-3 text-left text-[11px] font-semibold text-text-secondary"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function EmptyGridRow({ cols, text }: { cols: number; text: string }) {
  return (
    <tr>
      <td colSpan={cols} className="px-4 py-12 text-center text-[13px] text-text-tertiary">
        {text}
      </td>
    </tr>
  );
}

export function GridRow({
  children,
  selected,
}: {
  children: ReactNode;
  selected?: boolean;
}) {
  return (
    <tr
      className={cn(
        "group border-b border-border last:border-b-0",
        selected ? "bg-accent-subtle" : "hover:bg-subtle/70",
      )}
    >
      {children}
    </tr>
  );
}

export function GridCell({
  children,
  mono,
  muted,
}: {
  children: ReactNode;
  mono?: boolean;
  muted?: boolean;
}) {
  return (
    <td
      className={cn(
        "h-9 whitespace-nowrap px-3 py-1.5 align-middle text-text",
        mono && "technical",
        muted && "text-text-secondary",
      )}
    >
      {children}
    </td>
  );
}
