import {
  Braces,
  Cable,
  Database,
  DatabaseZap,
  FileText,
  FolderOpen,
  History,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Upload,
  Workflow,
} from "lucide-react";
import { MenuSidebar, type MenuItem } from "@/components/ui/menu";
import { useLanguage } from "@/i18n/LanguageProvider";
import { authApi } from "@/services/authApi";

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
    icon: <FolderOpen className={iconClassName} />,
    disabled: true,
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
  ];
}

export function ConsoleRail() {
  const { messages } = useLanguage();
  return (
    <MenuSidebar
      items={createLinks(messages)}
      logoutItem={{
        label: messages.nav.logout,
        icon: <LogOut className={iconClassName} />,
        onClick: () => {
          void authApi.logout().finally(() => location.assign("/login"));
        },
      }}
    />
  );
}
