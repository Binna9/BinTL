import { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function NoticeBanner({
  tone = "error",
  children,
}: {
  tone?: "error" | "ok";
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        "m-0 border-l-2 px-3 py-2 text-[13px]",
        tone === "ok"
          ? "border-success bg-success-subtle text-success"
          : "border-danger bg-danger-subtle text-danger",
      )}
    >
      {children}
    </p>
  );
}
