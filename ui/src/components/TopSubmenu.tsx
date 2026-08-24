import { Languages, Moon, Sun } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { useLanguage } from "@/i18n/LanguageProvider";

const items = [
  {
    id: "dashboard",
    icon: (
      <path d="M4 13h6a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1zm-1 7a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v4zm10 0a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v7zm1-10h6a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1z" />
    ),
  },
  {
    id: "profile",
    icon: (
      <path d="M12 2a5 5 0 1 0 5 5 5 5 0 0 0-5-5zm0 8a3 3 0 1 1 3-3 3 3 0 0 1-3 3zm9 11v-1a7 7 0 0 0-7-7h-4a7 7 0 0 0-7 7v1h2v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1z" />
    ),
  },
  {
    id: "language",
    isLanguageToggle: true,
  },
  {
    id: "theme",
    isThemeToggle: true,
  },
  {
    id: "settings",
    icon: (
      <>
        <path d="M12 16c2.206 0 4-1.794 4-4s-1.794-4-4-4-4 1.794-4 4 1.794 4 4 4zm0-6c1.084 0 2 .916 2 2s-.916 2-2 2-2-.916-2-2 .916-2 2-2z" />
        <path d="m2.845 16.136 1 1.73c.531.917 1.809 1.261 2.73.73l.529-.306A8.1 8.1 0 0 0 9 19.402V20c0 1.103.897 2 2 2h2c1.103 0 2-.897 2-2v-.598a8.132 8.132 0 0 0 1.896-1.111l.529.306c.923.53 2.198.188 2.731-.731l.999-1.729a2.001 2.001 0 0 0-.731-2.732l-.505-.292a7.718 7.718 0 0 0 0-2.224l.505-.292a2.002 2.002 0 0 0 .731-2.732l-.999-1.729c-.531-.92-1.808-1.265-2.731-.732l-.529.306A8.1 8.1 0 0 0 15 4.598V4c0-1.103-.897-2-2-2h-2c-1.103 0-2 .897-2 2v.598a8.132 8.132 0 0 0-1.896 1.111l-.529-.306c-.924-.531-2.2-.187-2.731.732l-.999 1.729a2.001 2.001 0 0 0 .731 2.732l.505.292a7.683 7.683 0 0 0 0 2.223l-.505.292a2.003 2.003 0 0 0-.731 2.733zm3.326-2.758A5.703 5.703 0 0 1 6 12c0-.462.058-.926.17-1.378a.999.999 0 0 0-.47-1.108l-1.123-.65.998-1.729 1.145.662a.997.997 0 0 0 1.188-.142 6.071 6.071 0 0 1 2.384-1.399A1 1 0 0 0 11 5.3V4h2v1.3a1 1 0 0 0 .708.956 6.083 6.083 0 0 1 2.384 1.399.999.999 0 0 0 1.188.142l1.144-.661 1 1.729-1.124.649a1 1 0 0 0-.47 1.108c.112.452.17.916.17 1.378 0 .461-.058.925-.171 1.378a1 1 0 0 0 .471 1.108l1.123.649-.998 1.729-1.145-.661a.996.996 0 0 0-1.188.142 6.071 6.071 0 0 1-2.384 1.399A1 1 0 0 0 13 18.7l.002 1.3H11v-1.3a1 1 0 0 0-.708-.956 6.083 6.083 0 0 1-2.384-1.399.992.992 0 0 0-1.188-.141l-1.144.662-1-1.729 1.124-.651a1 1 0 0 0 .471-1.108z" />
      </>
    ),
  },
] as const;

export function TopSubmenu() {
  const { theme, toggleTheme } = useTheme();
  const { messages, toggleLocale } = useLanguage();
  const isDark = theme === "dark";
  const labels = {
    dashboard: messages.nav.dashboard,
    profile: messages.nav.profile,
    settings: messages.nav.settings,
  };

  return (
    <div className="relative flex h-12 items-center justify-center">
      <article className="inline-flex h-full flex-row overflow-hidden rounded-2xl border border-border/80 bg-surface text-text shadow-[3px_4px_8px_-5px_rgba(15,23,42,0.35)] dark:shadow-[3px_4px_10px_-5px_rgba(0,0,0,0.65)]">
        {items.map((item, index) =>
          "isLanguageToggle" in item ? (
            <button
              key={item.id}
              type="button"
              onClick={toggleLocale}
              aria-label={messages.language.switchTo}
              title={messages.language.switchTo}
              className="group grid h-full w-14 place-items-center text-text outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
            >
              <span className="relative grid size-8 place-items-center rounded-lg transition-colors duration-200 group-hover:bg-accent-subtle group-hover:text-accent">
                <Languages className="size-[18px]" />
                <span className="absolute -bottom-0.5 -right-0.5 rounded bg-surface px-0.5 text-[8px] font-bold leading-3 text-current">
                  {messages.language.target}
                </span>
              </span>
            </button>
          ) : "isThemeToggle" in item ? (
            <button
              key={item.id}
              type="button"
              onClick={toggleTheme}
              aria-label={isDark ? messages.theme.toLight : messages.theme.toDark}
              aria-pressed={isDark}
              title={isDark ? messages.theme.light : messages.theme.dark}
              className="group grid h-full w-14 place-items-center text-text outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
            >
              <span className="grid size-8 place-items-center rounded-lg transition-colors duration-200 group-hover:bg-accent-subtle group-hover:text-accent">
                {isDark ? (
                  <Sun className="size-[18px]" />
                ) : (
                  <Moon className="size-[18px]" />
                )}
              </span>
            </button>
          ) : (
            <label
              key={item.id}
              htmlFor={`top-submenu-${item.id}`}
              title={labels[item.id]}
              className="group relative flex h-full w-14 cursor-pointer flex-row items-center justify-center text-text outline-none"
            >
              <input
                className="peer/expand hidden"
                type="radio"
                name="top-submenu-path"
                id={`top-submenu-${item.id}`}
                defaultChecked={index === 0}
              />
              <span className="flex size-8 items-center justify-center rounded-lg transition-[color,background-color,box-shadow] duration-200 group-hover:bg-accent-subtle group-hover:text-accent peer-checked/expand:bg-accent-subtle peer-checked/expand:text-accent peer-checked/expand:shadow-[1px_2px_5px_-2px_rgba(59,130,246,0.45)]">
                <svg
                  className="fill-current text-current"
                  xmlns="http://www.w3.org/2000/svg"
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  {item.icon}
                </svg>
              </span>
              <span className="sr-only">{labels[item.id]}</span>
            </label>
          )
        )}
      </article>
    </div>
  );
}
