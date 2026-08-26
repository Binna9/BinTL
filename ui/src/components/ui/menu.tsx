import * as React from "react";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import { ChevronDown, ChevronRight } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";

export interface MenuItem {
  icon: React.ReactNode;
  label: string;
  to: string;
  end?: boolean;
  disabled?: boolean;
  children?: MenuItem[];
}

interface MenuSidebarProps {
  items: MenuItem[];
  className?: string;
}

const sidebarVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.06 },
  },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, x: -12 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { type: "spring", stiffness: 130, damping: 18 },
  },
};

function MenuLink({ item, nested = false }: { item: MenuItem; nested?: boolean }) {
  const { messages } = useLanguage();
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
      className={({ isActive }) =>
        cn(
          "group flex min-w-0 items-center gap-2.5 rounded-lg py-2.5 text-sm font-medium !text-text no-underline outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40",
          nested ? "px-2" : "px-3",
          isActive ? "bg-accent-subtle" : "hover:bg-subtle",
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={cn(
              "h-5 w-[3px] shrink-0 rounded-full",
              isActive ? "bg-accent" : "bg-transparent",
            )}
            aria-hidden="true"
          />
          <span
            className={cn(
              "shrink-0 transition-transform duration-150 group-hover:scale-110",
              nested ? "size-4" : "size-[18px]",
            )}
            aria-hidden="true"
          >
            {item.icon}
          </span>
          <span className="min-w-0 flex-1 origin-left truncate transition-transform duration-150 group-hover:scale-110 group-hover:font-bold">
            {item.label}
          </span>
          <ChevronRight
            className={cn(
              "size-4 shrink-0 transition-opacity",
              isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
            aria-hidden="true"
          />
        </>
      )}
    </NavLink>
  );
}

function MenuGroup({ item }: { item: MenuItem }) {
  const location = useLocation();
  const { messages } = useLanguage();
  const hasActiveChild =
    item.children?.some(
      (child) =>
        !child.disabled &&
        (location.pathname === child.to ||
          (!child.end && location.pathname.startsWith(`${child.to}/`))),
    ) ?? false;
  const [isOpen, setIsOpen] = React.useState(hasActiveChild);

  React.useEffect(() => {
    if (hasActiveChild) setIsOpen(true);
  }, [hasActiveChild]);

  return (
    <>
      <button
        type="button"
        className={cn(
          "group flex w-full min-w-0 items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40",
          hasActiveChild ? "bg-accent-subtle text-text" : "text-text hover:bg-subtle",
        )}
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
      >
        <span
          className={cn(
            "h-5 w-[3px] shrink-0 rounded-full",
            hasActiveChild ? "bg-accent" : "bg-transparent",
          )}
          aria-hidden="true"
        />
        <span
          className="size-[18px] shrink-0 transition-transform duration-150 group-hover:scale-110"
          aria-hidden="true"
        >
          {item.icon}
        </span>
        <span className="min-w-0 flex-1 origin-left truncate text-left transition-transform duration-150 group-hover:scale-110 group-hover:font-bold">
          {item.label}
        </span>
        <motion.span
          className="size-4 shrink-0 text-text"
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
              className="ml-5 space-y-1 border-l border-border py-1 pl-2"
              aria-label={messages.nav.submenu(item.label)}
            >
              {item.children?.map((child) => (
                <MenuLink key={child.to} item={child} nested />
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

export const MenuSidebar = React.forwardRef<HTMLElement, MenuSidebarProps>(
  ({ items, className }, ref) => {
    const { messages } = useLanguage();
    return (
    <motion.aside
      ref={ref}
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-surface p-3 text-text",
        className,
      )}
      initial="hidden"
      animate="visible"
      variants={sidebarVariants}
      aria-label={messages.nav.mainMenu}
    >
      <nav className="flex-1 space-y-1" aria-label={messages.nav.platform}>
        {items.map((item) => (
          <motion.div key={item.to} variants={itemVariants}>
            {item.children ? (
              <MenuGroup item={item} />
            ) : (
              <MenuLink item={item} />
            )}
          </motion.div>
        ))}
      </nav>
    </motion.aside>
    );
  },
);

MenuSidebar.displayName = "MenuSidebar";
