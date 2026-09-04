import {
  AppWindow,
  Braces,
  Cable,
  CalendarClock,
  Database,
  DatabaseZap,
  FileText,
  Filter,
  GitBranch,
  History,
  LayoutDashboard,
  LayoutTemplate,
  ListChecks,
  Puzzle,
  Upload,
  Workflow,
} from "lucide-react";
import { MenuSidebar, type MenuItem } from "@/components/ui/menu";
import { useLanguage } from "@/i18n/LanguageProvider";

const iconClassName = "h-full w-full";

function createLinks(messages: ReturnType<typeof useLanguage>["messages"]): MenuItem[] {
  return [
    {
      to: "/",
      label: messages.nav.overview,
      icon: <LayoutDashboard className={iconClassName} />,
      end: true,
    },
    {
      to: "/workspace",
      label: messages.nav.workspace,
      icon: <AppWindow className={iconClassName} />,
      children: [
        {
          to: "/workspace",
          label: messages.nav.workspaceCanvas,
          icon: <LayoutTemplate className={iconClassName} />,
          isActive: (pathname) =>
            pathname === "/workspace" ||
            (pathname.startsWith("/workspace/") && !pathname.startsWith("/workspace/runs")),
        },
        {
          to: "/chips",
          label: messages.nav.chipCatalog,
          icon: <Puzzle className={iconClassName} />,
          end: true,
        },
        {
          to: "/workspace/runs",
          label: messages.nav.chipRuns,
          icon: <History className={iconClassName} />,
          end: true,
        },
      ],
    },
    {
      to: "/extract",
      label: messages.nav.extract,
      icon: <DatabaseZap className={iconClassName} />,
      children: [
        {
          to: "/extract/api",
          label: "API",
          icon: <Braces className={iconClassName} />,
        },
        {
          to: "/db",
          label: "DB",
          icon: <Database className={iconClassName} />,
        },
        {
          to: "/files",
          label: messages.nav.files,
          icon: <FileText className={iconClassName} />,
        },
        {
          to: "/extracts",
          label: messages.nav.extractResults,
          icon: <ListChecks className={iconClassName} />,
        },
      ],
    },
    {
      to: "/transform",
      label: messages.nav.transform,
      icon: <Workflow className={iconClassName} />,
      isActive: (pathname) =>
        pathname === "/transform" ||
        (/^\/transform\/[^/]+$/.test(pathname) && pathname !== "/transform/reshape"),
      children: [
        {
          to: "/transform/clean",
          label: messages.nav.transformClean,
          icon: <Filter className={iconClassName} />,
        },
        {
          to: "/transform/combine",
          label: messages.nav.transformCombine,
          icon: <Workflow className={iconClassName} />,
        },
        {
          to: "/transform/aggregate",
          label: messages.nav.transformAggregate,
          icon: <ListChecks className={iconClassName} />,
        },
        {
          to: "/transform/reshape",
          label: messages.nav.transformReshape,
          icon: <GitBranch className={iconClassName} />,
        },
        {
          to: "/transforms",
          label: messages.nav.transformResults,
          icon: <ListChecks className={iconClassName} />,
        },
      ],
    },
    {
      to: "/load",
      label: messages.nav.load,
      icon: <Upload className={iconClassName} />,
    },
    {
      to: "/history",
      label: messages.nav.history,
      icon: <History className={iconClassName} />,
    },
    {
      to: "/connections",
      label: messages.nav.connections,
      icon: <Cable className={iconClassName} />,
    },
    {
      to: "/schedule",
      label: messages.nav.schedule,
      icon: <CalendarClock className={iconClassName} />,
    },
  ];
}

export function ConsoleRail({ inactive = false }: { inactive?: boolean }) {
  const { messages } = useLanguage();
  return <MenuSidebar items={createLinks(messages)} inactive={inactive} />;
}
