import {
  AppWindow,
  Braces,
  Cable,
  CalendarClock,
  Database,
  DatabaseZap,
  FileDown,
  FileText,
  History,
  LayoutDashboard,
  LayoutTemplate,
  ListChecks,
  Puzzle,
  ShieldCheck,
  Upload,
  Workflow,
  Wrench,
} from "lucide-react";
import { MenuSidebar, type MenuItem } from "@/components/ui/menu";
import { useLanguage } from "@/i18n/LanguageProvider";
import { isWorkspaceCanvasPath } from "@/lib/navigation";

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
          isActive: (pathname) => isWorkspaceCanvasPath(pathname),
        },
        {
          to: "/chips",
          label: messages.nav.chipCatalog,
          icon: <Puzzle className={iconClassName} />,
          end: true,
        },
      ],
    },
    {
      to: "/tools",
      label: messages.nav.tools,
      icon: <Wrench className={iconClassName} />,
      children: [
        {
          to: "/extract",
          label: messages.nav.extract,
          icon: <DatabaseZap className={iconClassName} />,
          children: [
            {
              to: "/extract/api",
              label: messages.nav.apiRecipe,
              icon: <Braces className={iconClassName} />,
              isActive: (pathname) =>
                pathname === "/extract/api"
                || pathname.endsWith("/extract-api"),
            },
            {
              to: "/db",
              label: messages.nav.dbRecipe,
              icon: <Database className={iconClassName} />,
              isActive: (pathname) =>
                pathname === "/db"
                || pathname === "/query"
                || pathname.endsWith("/extract"),
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
          children: [
            {
              to: "/transform",
              label: messages.nav.transformRecipe,
              icon: <Workflow className={iconClassName} />,
              isActive: (pathname) =>
                pathname === "/transform"
                || pathname.startsWith("/transform/")
                || /^\/chips\/[^/]+\/transform(?:\/[^/]+)?$/.test(pathname)
                || /^\/workspace\/[^/]+\/chips\/[^/]+\/transform(?:\/[^/]+)?$/.test(pathname),
            },
            {
              to: "/transforms",
              label: messages.nav.transformResults,
              icon: <ListChecks className={iconClassName} />,
            },
          ],
        },
        {
          to: "/script",
          label: messages.nav.script,
          icon: <Braces className={iconClassName} />,
          children: [
            {
              to: "/script",
              label: messages.nav.scriptRecipe,
              icon: <Braces className={iconClassName} />,
              isActive: (pathname) =>
                pathname === "/script"
                || pathname.startsWith("/script/")
                || /^\/chips\/[^/]+\/script$/.test(pathname)
                || /^\/workspace\/[^/]+\/chips\/[^/]+\/script$/.test(pathname),
            },
            {
              to: "/scripts",
              label: messages.nav.scriptResults,
              icon: <ListChecks className={iconClassName} />,
            },
          ],
        },
        {
          to: "/load",
          label: messages.nav.load,
          icon: <Upload className={iconClassName} />,
          children: [
            {
              to: "/load",
              label: messages.nav.loadRecipe,
              icon: <Upload className={iconClassName} />,
              isActive: (pathname) =>
                pathname === "/load"
                || /^\/chips\/[^/]+\/load(?:\/[^/]+)?$/.test(pathname)
                || /^\/workspace\/[^/]+\/chips\/[^/]+\/load(?:\/[^/]+)?$/.test(pathname),
            },
          ],
        },
        {
          to: "/validation",
          label: messages.nav.validation,
          icon: <ShieldCheck className={iconClassName} />,
          children: [
            {
              to: "/validation",
              label: messages.nav.validationRecipe,
              icon: <ShieldCheck className={iconClassName} />,
              isActive: (pathname) =>
                pathname === "/validation"
                || /^\/chips\/[^/]+\/validation$/.test(pathname)
                || /^\/workspace\/[^/]+\/chips\/[^/]+\/validation$/.test(pathname),
            },
          ],
        },
      ],
    },
    {
      to: "/history",
      label: messages.nav.history,
      icon: <History className={iconClassName} />,
      children: [
        {
          to: "/history",
          label: messages.nav.chipRuns,
          icon: <History className={iconClassName} />,
          end: true,
        },
        {
          to: "/validation/results",
          label: messages.nav.validationHistory,
          icon: <ListChecks className={iconClassName} />,
        },
        {
          to: "/history/exports",
          label: messages.nav.exportHistory,
          icon: <FileDown className={iconClassName} />,
        },
      ],
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
