import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronRight } from "lucide-react";
import { NavLink } from "react-router-dom";
import { useRenderLocation } from "@/hooks/useViewTransitionLocation";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";

export interface MenuItem {
  icon: React.ReactNode;
  label: string;
  to: string;
  end?: boolean;
  disabled?: boolean;
  isActive?: (pathname: string) => boolean;
  children?: MenuItem[];
}

function menuItemActive(pathname: string, item: MenuItem, inactive: boolean) {
  if (inactive || item.disabled) return false;
  if (item.isActive) return item.isActive(pathname);
  if (item.end) return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

function hasActiveDescendant(pathname: string, item: MenuItem, inactive: boolean): boolean {
  if (inactive) return false;
  if (!item.children?.length) return menuItemActive(pathname, item, inactive);
  return item.children.some((child) => hasActiveDescendant(pathname, child, inactive));
}

interface MenuSidebarProps {
  items: MenuItem[];
  className?: string;
  inactive?: boolean;
}

const MENU_OPEN_STORAGE_KEY = "bintl.sidebar.open-groups";

function storedOpenGroups(): Set<string> {
  try {
    const raw = window.sessionStorage.getItem(MENU_OPEN_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function MenuLink({
  item,
  nested = false,
  inactive = false,
}: {
  item: MenuItem;
  nested?: boolean;
  inactive?: boolean;
}) {
  const { messages } = useLanguage();
  const location = useRenderLocation();
  const active = menuItemActive(location.pathname, item, inactive);

  if (item.disabled) {
    return (
      <div
        className={cn(
          "flex min-w-0 cursor-default items-center gap-2.5 rounded-lg py-2.5 text-sm font-medium text-text-tertiary",
          nested ? "px-2" : "px-3",
        )}
        aria-disabled="true"
        title={`${item.label} — ${messages.common.comingSoon}`}
      >
        <span className="h-5 w-[3px] shrink-0 rounded-full bg-transparent" aria-hidden="true" />
        <span
          className={cn("shrink-0", nested ? "size-4" : "size-[18px]")}
          aria-hidden="true"
        >
          {item.icon}
        </span>
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        <span className="text-[10px] font-semibold">{messages.common.comingSoon}</span>
      </div>
    );
  }

  return (
    <NavLink
      to={item.to}
      end={item.end}
      title={item.label}
      className={() =>
        cn(
          "group flex min-w-0 items-center gap-2.5 rounded-lg py-2.5 text-sm font-medium !text-text no-underline outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40",
          nested ? "px-2" : "px-3",
          active ? "bg-accent-subtle text-accent" : "hover:bg-subtle",
        )
      }
    >
      {() => (
        <>
          <span
            className={cn(
              "h-5 w-[3px] shrink-0 rounded-full",
              active ? "bg-accent" : "bg-transparent",
            )}
            aria-hidden="true"
          />
          <span
            className={cn(
              "shrink-0 transition-transform duration-150 group-hover:scale-110",
              nested ? "size-4" : "size-[18px]",
              active && "text-accent",
            )}
            aria-hidden="true"
          >
            {item.icon}
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 origin-left truncate transition-transform duration-150 group-hover:scale-110",
              active ? "font-semibold" : "group-hover:font-bold",
            )}
          >
            {item.label}
          </span>
          <ChevronRight
            className={cn(
              "size-4 shrink-0 transition-opacity",
              active ? "text-accent opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
            aria-hidden="true"
          />
        </>
      )}
    </NavLink>
  );
}

function MenuGroup({
  item,
  depth = 0,
  inactive = false,
  openGroups,
  setGroupOpen,
}: {
  item: MenuItem;
  depth?: number;
  inactive?: boolean;
  openGroups: Set<string>;
  setGroupOpen: (key: string, open: boolean) => void;
}) {
  const location = useRenderLocation();
  const { messages } = useLanguage();
  const childActive = hasActiveDescendant(location.pathname, item, inactive);
  const isOpen = openGroups.has(item.to);

  React.useEffect(() => {
    if (childActive) setGroupOpen(item.to, true);
  }, [childActive, item.to, setGroupOpen]);

  return (
    <>
      <button
        type="button"
        className={cn(
          "group flex w-full min-w-0 items-center gap-2.5 rounded-lg py-2.5 text-sm font-medium text-text outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40",
          depth > 0 ? "px-2" : "px-3",
          childActive ? "bg-subtle" : "hover:bg-subtle",
        )}
        aria-expanded={isOpen}
        onClick={() => setGroupOpen(item.to, !isOpen)}
      >
        <span className="h-5 w-[3px] shrink-0 rounded-full bg-transparent" aria-hidden="true" />
        <span
          className={cn(
            "shrink-0 transition-transform duration-150 group-hover:scale-110",
            depth > 0 ? "size-4" : "size-[18px]",
          )}
          aria-hidden="true"
        >
          {item.icon}
        </span>
        <span className="min-w-0 flex-1 origin-left truncate text-left transition-transform duration-150 group-hover:scale-110 group-hover:font-bold">
          {item.label}
        </span>
        <motion.span
          className="size-4 shrink-0 text-text-secondary"
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          aria-hidden="true"
        >
          <ChevronDown className="size-4" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {isOpen ? (
          <motion.div
            className="overflow-hidden"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeInOut" }}
          >
            <div
              className={cn(
                "space-y-1 border-l border-border py-1 pl-2",
                depth === 0 ? "ml-5" : "ml-3",
              )}
              aria-label={messages.nav.submenu(item.label)}
            >
              {item.children?.map((child) =>
                child.children?.length ? (
                  <MenuGroup
                    key={child.to}
                    item={child}
                    depth={depth + 1}
                    inactive={inactive}
                    openGroups={openGroups}
                    setGroupOpen={setGroupOpen}
                  />
                ) : (
                  <MenuLink key={child.to} item={child} nested inactive={inactive} />
                ),
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

export const MenuSidebar = React.forwardRef<HTMLElement, MenuSidebarProps>(
  ({ items, className, inactive = false }, ref) => {
    const { messages } = useLanguage();
    const [openGroups, setOpenGroups] = React.useState<Set<string>>(storedOpenGroups);
    const setGroupOpen = React.useCallback((key: string, open: boolean) => {
      setOpenGroups((current) => {
        const next = new Set(current);
        if (open) next.add(key); else next.delete(key);
        try {
          window.sessionStorage.setItem(MENU_OPEN_STORAGE_KEY, JSON.stringify([...next]));
        } catch {
          // Storage may be unavailable in privacy-restricted browser contexts.
        }
        return next;
      });
    }, []);
    return (
      <motion.aside
        ref={ref}
        className={cn(
          "flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-surface p-3 text-text",
          className,
        )}
        initial={false}
        aria-label={messages.nav.mainMenu}
      >
        <nav
          className="scroll-pane min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain"
          aria-label={messages.nav.platform}
        >
          {items.map((item) => (
            <motion.div key={item.to}>
              {item.children ? (
                <MenuGroup
                  item={item}
                  inactive={inactive}
                  openGroups={openGroups}
                  setGroupOpen={setGroupOpen}
                />
              ) : (
                <MenuLink item={item} inactive={inactive} />
              )}
            </motion.div>
          ))}
        </nav>
      </motion.aside>
    );
  },
);

MenuSidebar.displayName = "MenuSidebar";
