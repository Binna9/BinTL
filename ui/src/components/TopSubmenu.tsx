import { Languages, LogOut, Moon, Settings, Sun, User } from "lucide-react";
import { type ReactNode, useState } from "react";
import { SettingsDialog } from "@/components/SettingsDialog";
import { useTheme } from "@/hooks/useTheme";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { authApi } from "@/services/authApi";

function IconButton({
  label,
  pressed,
  danger,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  danger?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={cn(
        "group grid h-full w-14 place-items-center text-text outline-none focus-visible:ring-2 focus-visible:ring-inset",
        danger ? "focus-visible:ring-danger/40" : "focus-visible:ring-accent/40",
      )}
    >
      <span
        className={cn(
          "relative grid size-8 place-items-center rounded-lg transition-colors duration-200",
          danger
            ? "group-hover:bg-danger-subtle group-hover:text-danger"
            : "group-hover:bg-accent-subtle group-hover:text-accent",
        )}
      >
        {children}
      </span>
    </button>
  );
}

export function TopSubmenu({ prefsOnly = false }: { prefsOnly?: boolean }) {
  const { theme, toggleTheme } = useTheme();
  const { messages, toggleLocale } = useLanguage();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const isDark = theme === "dark";

  function logout() {
    void authApi.logout().finally(() => location.assign("/login"));
  }

  return (
    <div className="relative flex h-12 items-center justify-center">
      <article className="inline-flex h-full flex-row overflow-hidden rounded-2xl border border-border/80 bg-surface text-text shadow-[3px_4px_8px_-5px_rgba(15,23,42,0.35)] dark:shadow-[3px_4px_10px_-5px_rgba(0,0,0,0.65)]">
        {prefsOnly ? null : (
          <IconButton label={messages.nav.profile}>
            <User className="size-[18px]" />
          </IconButton>
        )}
        <IconButton label={messages.language.switchTo} onClick={toggleLocale}>
          <Languages className="size-[18px]" />
          <span className="absolute -bottom-0.5 -right-0.5 rounded bg-surface px-0.5 text-[8px] font-bold leading-3 text-current">
            {messages.language.target}
          </span>
        </IconButton>
        <IconButton
          label={isDark ? messages.theme.toLight : messages.theme.toDark}
          pressed={isDark}
          onClick={toggleTheme}
        >
          {isDark ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
        </IconButton>
        {prefsOnly ? null : (
          <>
            <IconButton label={messages.nav.settings} onClick={() => setSettingsOpen(true)}>
              <Settings className="size-[18px]" />
            </IconButton>
            <IconButton danger label={messages.nav.logout} onClick={logout}>
              <LogOut className="size-[18px]" />
            </IconButton>
          </>
        )}
      </article>
      {prefsOnly ? null : (
        <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}
