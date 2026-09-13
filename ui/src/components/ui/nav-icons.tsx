import {
  AppWindow,
  Braces,
  Cable,
  CalendarClock,
  Database,
  FileText,
  History,
  LayoutDashboard,
  ListChecks,
  Puzzle,
  ShieldCheck,
  Upload,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";

export type NavIconName =
  | "overview"
  | "workspace"
  | "chips"
  | "runs"
  | "files"
  | "connections"
  | "query"
  | "api"
  | "extracts"
  | "transform"
  | "jobs"
  | "transformFiles"
  | "load"
  | "validation"
  | "validationRules"
  | "validationResults"
  | "history"
  | "schedule";

const icons: Record<NavIconName, LucideIcon> = {
  overview: LayoutDashboard,
  workspace: AppWindow,
  chips: Puzzle,
  runs: History,
  files: FileText,
  connections: Cable,
  query: Database,
  api: Braces,
  extracts: ListChecks,
  transform: Workflow,
  jobs: Workflow,
  transformFiles: ListChecks,
  load: Upload,
  validation: ShieldCheck,
  validationRules: ListChecks,
  validationResults: History,
  history: History,
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
  return <Icon className={cn("shrink-0", className ?? "size-[1.05em]")} aria-hidden="true" />;
}
