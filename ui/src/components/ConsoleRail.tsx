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
import { authApi } from "@/services/authApi";

const iconClassName = "h-full w-full";

const links: MenuItem[] = [
  {
    to: "/",
    label: "개요",
    icon: <LayoutDashboard className={iconClassName} />,
    end: true,
  },
  {
    to: "/workspace",
    label: "작업 공간",
    icon: <FolderOpen className={iconClassName} />,
    disabled: true,
  },
  {
    to: "/extract",
    label: "추출",
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
        label: "파일",
        icon: <FileText className={iconClassName} />,
      },
      {
        to: "/extracts",
        label: "추출 결과",
        icon: <ListChecks className={iconClassName} />,
      },
    ],
  },
  {
    to: "/transform",
    label: "변환",
    icon: <Workflow className={iconClassName} />,
  },
  {
    to: "/load",
    label: "적재",
    icon: <Upload className={iconClassName} />,
  },
  {
    to: "/history",
    label: "이력 관리",
    icon: <History className={iconClassName} />,
  },
  {
    to: "/connections",
    label: "커넥션",
    icon: <Cable className={iconClassName} />,
  },
];

export function ConsoleRail() {
  return (
    <MenuSidebar
      items={links}
      logoutItem={{
        label: "로그아웃",
        icon: <LogOut className={iconClassName} />,
        onClick: () => {
          void authApi.logout().finally(() => location.assign("/login"));
        },
      }}
    />
  );
}
