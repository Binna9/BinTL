import {
  Braces,
  Cable,
  CalendarClock,
  Database,
  DatabaseZap,
  FileText,
  AppWindow,
  History,
  LayoutDashboard,
  ListChecks,
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
          disabled: true,
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

export function ConsoleRail() {
  const { messages } = useLanguage();
  return <MenuSidebar items={createLinks(messages)} />;
}
