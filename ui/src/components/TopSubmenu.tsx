import { Languages, LogOut, Moon, Settings, Sun, User } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AccountDialog } from "@/components/auth/AccountDialog";
import { SettingsDialog } from "@/components/auth/SettingsDialog";
import { clearStoredLayouts } from "@/components/overview/layout";
import { useSession } from "@/hooks/auth/useSession";
import { useTheme } from "@/hooks/theme/useTheme";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { showConfirm } from "@/lib/notifications";
import { authApi } from "@/services/auth/authApi";

function IconButton({ label, pressed, danger, onClick, children }: {
  label: string;
  pressed?: boolean;
  danger?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} aria-label={label} aria-pressed={pressed} title={label}
      className={cn("group grid h-full w-14 place-items-center text-text outline-none focus-visible:ring-2 focus-visible:ring-inset", danger ? "focus-visible:ring-danger/40" : "focus-visible:ring-accent/40")}
    >
      <span className={cn("relative grid size-8 place-items-center rounded-lg transition-colors duration-200", danger ? "group-hover:bg-danger-subtle group-hover:text-danger" : "group-hover:bg-accent-subtle group-hover:text-accent")}>
        {children}
      </span>
    </button>
  );
}

export function TopSubmenu({ prefsOnly = false }: { prefsOnly?: boolean }) {
  const { theme, toggleTheme } = useTheme();
  const { messages, toggleLocale } = useLanguage();
  const navigate = useNavigate();
  const { user, clearSession } = useSession();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const isDark = theme === "dark";

  async function logout() {
    const confirmed = await showConfirm(messages.nav.logoutConfirmTitle, messages.nav.logoutConfirmMessage, { tone: "danger", confirmLabel: messages.nav.logout });
    if (!confirmed) return;
    clearStoredLayouts();
    void authApi.logout().finally(() => {
      clearSession();
      navigate("/login", { replace: true });
    });
  }

  return (
    <div className="relative flex h-12 items-center">
      {prefsOnly || !user ? null : (
        <div
          className="mr-6 flex max-w-[12rem] items-center gap-2.5 rounded-2xl py-1 pr-3 pl-1 transition-colors hover:bg-accent-subtle/70"
          aria-label={`${user.username} (@${user.userid})`}
          title={`${user.username} (@${user.userid})`}
        >
          <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-full bg-accent text-[13px] font-bold text-white ring-2 ring-accent/15 ring-offset-2 ring-offset-surface">
            {user.avatar_data_url ? (
              <img src={user.avatar_data_url} alt="" className="size-full object-cover" />
            ) : (
              <User className="size-4" aria-hidden="true" />
            )}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-semibold leading-5 text-text">{user.username}</span>
            <span className="mt-0.5 block truncate text-[11px] leading-3 text-text-tertiary">@{user.userid}</span>
          </span>
        </div>
      )}
      <article className="inline-flex h-full flex-row overflow-hidden rounded-2xl border border-border/80 bg-surface text-text shadow-[3px_4px_8px_-5px_rgba(15,23,42,0.35)] dark:shadow-[3px_4px_10px_-5px_rgba(0,0,0,0.65)]">
        {prefsOnly ? null : (
          <IconButton label={user ? `${user.username} (@${user.userid})` : messages.nav.profile} pressed={accountOpen} onClick={() => setAccountOpen(true)}>
            <User className="size-[18px]" />
          </IconButton>
        )}
        <IconButton label={messages.language.switchTo} onClick={toggleLocale}>
          <Languages className="size-[18px]" />
          <span className="absolute -bottom-0.5 -right-0.5 rounded bg-surface px-0.5 text-[8px] font-bold leading-3 text-current">{messages.language.target}</span>
        </IconButton>
        <IconButton label={isDark ? messages.theme.toLight : messages.theme.toDark} pressed={isDark} onClick={toggleTheme}>
          {isDark ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
        </IconButton>
        {prefsOnly ? null : (
          <>
            <IconButton label={messages.nav.settings} onClick={() => setSettingsOpen(true)}><Settings className="size-[18px]" /></IconButton>
            <IconButton danger label={messages.nav.logout} onClick={() => void logout()}><LogOut className="size-[18px]" /></IconButton>
          </>
        )}
      </article>
      {prefsOnly ? null : (
        <>
          <AccountDialog open={accountOpen} onClose={() => setAccountOpen(false)} />
          <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        </>
      )}
    </div>
  );
}
