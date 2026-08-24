import { NavLink } from "react-router-dom";
import { Button } from "@/components/Button";
import { NavIcon, type NavIconName } from "@/components/NavIcons";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";

const links: { to: string; label: string; icon: NavIconName; end?: boolean }[] = [
  { to: "/", label: "개요", icon: "overview", end: true },
  { to: "/files", label: "파일", icon: "files" },
  { to: "/connections", label: "커넥션", icon: "connections" },
  { to: "/query", label: "쿼리", icon: "query" },
  { to: "/extracts", label: "추출", icon: "extracts" },
  { to: "/jobs", label: "작업", icon: "jobs" },
];

export function ConsoleRail() {
  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-surface">
      <div className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.1em] text-text-tertiary">
        데이터 플랫폼
      </div>
      <nav className="flex min-w-0 flex-col px-2">
        {links.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.end}
            title={l.label}
            className={({ isActive }) =>
              cn(
                "flex min-w-0 items-center gap-2 overflow-hidden border-l-2 px-3 py-2 text-[15px] no-underline",
                isActive
                  ? "border-accent bg-accent-subtle font-medium text-accent"
                  : "border-transparent text-text-secondary hover:bg-subtle hover:text-text",
              )
            }
          >
            <NavIcon name={l.icon} className="size-4" />
            <span className="min-w-0 truncate">{l.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto min-w-0 overflow-hidden border-t border-border p-2">
        <div className="mb-1 truncate px-2 py-1 text-[12px] text-text-tertiary">로컬 세션</div>
        <Button
          className="w-full min-w-0 justify-start overflow-hidden"
          variant="quiet"
          type="button"
          onClick={() => {
            void api.logout().finally(() => location.assign("/login"));
          }}
        >
          <span className="truncate">로그아웃</span>
        </Button>
      </div>
    </aside>
  );
}
