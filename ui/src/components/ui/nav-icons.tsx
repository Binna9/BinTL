import { Cable, CalendarClock, Database, DatabaseZap, FileText, LayoutDashboard, Workflow, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

export type NavIconName =
  | "overview"
  | "files"
  | "connections"
  | "query"
  | "extracts"
  | "jobs"
  | "schedule";

const icons: Record<NavIconName, LucideIcon> = {
  overview: LayoutDashboard,
  files: FileText,
  connections: Cable,
  query: Database,
  extracts: DatabaseZap,
  jobs: Workflow,
  schedule: CalendarClock,
};

export function NavIcon({
  name,
  className,
}: {
  name: NavIconName;
  className?: string;
}) {
  const Icon = icons[name];
  return <Icon className={cn("size-[1.05em] shrink-0", className)} aria-hidden="true" />;
}
