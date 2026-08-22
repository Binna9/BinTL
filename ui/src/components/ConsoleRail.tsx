import { Link, NavLink } from "react-router-dom";
import { Button } from "@/components/Button";
import { api } from "@/lib/api";

const links = [
  { to: "/", label: "개요", end: true },
  { to: "/files", label: "파일" },
  { to: "/connections", label: "커넥션" },
  { to: "/extracts", label: "추출" },
  { to: "/jobs", label: "작업" },
];

export function ConsoleRail() {
  return (
    <aside className="sticky top-0 z-30 flex h-screen w-52 flex-col border-r border-border bg-surface">
      <Link
        to="/"
        className="flex h-14 items-center border-b border-border px-4 text-text no-underline"
      >
        <span className="mr-2 grid size-6 place-items-center rounded bg-text font-mono text-[10px] font-semibold text-white">
          BT
        </span>
        <span className="text-sm font-semibold tracking-[-0.01em]">BinTL</span>
      </Link>
      <div className="px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-tertiary">
        데이터 플랫폼
      </div>
      <nav className="flex flex-col px-2">
        {links.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.end}
            className={({ isActive }) =>
              `border-l-2 px-3 py-2 text-[13px] no-underline ${
                isActive
                  ? "border-accent bg-accent-subtle font-medium text-accent"
                  : "border-transparent text-text-secondary hover:bg-subtle hover:text-text"
              }`
            }
          >
            {l.label}
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto border-t border-border p-2">
        <div className="mb-1 px-2 py-1 text-[11px] text-text-tertiary">로컬 세션</div>
        <Button
          className="w-full justify-start"
          variant="quiet"
          type="button"
          onClick={() => {
            void api.logout().finally(() => location.assign("/login"));
          }}
        >
          로그아웃
        </Button>
      </div>
    </aside>
  );
}
