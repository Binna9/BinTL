import { cn } from "@/lib/cn";

export function selectableClass(active?: boolean) {
  return cn(
    "relative transition-colors duration-150",
    "before:absolute before:inset-y-1 before:left-0.5 before:w-0.5 before:rounded-full before:transition-colors",
    active
      ? "bg-gradient-to-r from-accent/12 via-accent/[0.05] to-transparent before:bg-accent"
      : "before:bg-transparent hover:bg-gradient-to-r hover:from-black/[0.045] hover:via-black/[0.02] hover:to-transparent hover:before:bg-border-strong",
  );
}
