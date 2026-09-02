import { FormEvent, useState } from "react";
import { Eye, EyeOff, KeyRound, Lock, LogIn, UserPlus, UserRound } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { BrandMark } from "@/components/BrandMark";
import { ReleaseBadge } from "@/components/ReleaseBadge";
import { TopSubmenu } from "@/components/TopSubmenu";
import { ShaderBackground } from "@/components/ui/adisyon-shader";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { useLanguage } from "@/i18n/LanguageProvider";
import { toastError, toastSuccess } from "@/lib/notifications";
import { authApi } from "@/services/auth/authApi";
import { useSession } from "@/hooks/auth/useSession";
import { clearStoredLayouts } from "@/components/overview/layout";

function GoogleMark() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

export function SessionGatePage() {
  const { messages } = useLanguage();
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [userid, setUserid] = useState("admin");
  const [password, setPassword] = useState("admin");
  const [busy, setBusy] = useState(false);
  const [keepLogin, setKeepLogin] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await authApi.login(userid, password);
      clearStoredLayouts();
      await refresh();
      toastSuccess(messages.login.success);
      navigate("/");
    } catch (err) {
      toastError(messages.errors.login, err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative min-h-screen overflow-hidden">
      <ShaderBackground className="pointer-events-none absolute inset-0 h-full w-full" />
      <div className="absolute right-5 top-5 z-20">
        <TopSubmenu prefsOnly />
      </div>
      <div className="relative z-10 flex min-h-screen items-center justify-center p-6">
        {/* Shell carries drop-shadow so the cut corner still casts a shaped shadow. */}
        <div className="login-card-shell w-full max-w-[30rem]">
          <section className="login-card relative flex w-full flex-col overflow-hidden border border-border">
            <span className="login-card-slash" aria-hidden="true">
              <svg viewBox="0 0 88 88">
                <defs>
                  <linearGradient id="login-card-slash-grad" x1="1" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="var(--login-slash)" />
                    <stop offset="0.22" stopColor="var(--login-slash)" />
                    <stop offset="0.36" stopColor="var(--login-slash-hi)" />
                    <stop offset="0.5" stopColor="var(--login-slash-hi)" />
                    <stop offset="0.64" stopColor="var(--login-slash-hi)" />
                    <stop offset="0.78" stopColor="var(--login-slash)" />
                    <stop offset="1" stopColor="var(--login-slash)" />
                  </linearGradient>
                </defs>
                <path className="login-card-slash-outer" d="M86 -4 L-4 86" />
                <path className="login-card-slash-inner" d="M72 -4 L-4 72" />
                {/* Deeper parallel slash, ~2× outer thickness. */}
                <path className="login-card-slash-deep" d="M48 -4 L-4 48" />
              </svg>
            </span>
            <ReleaseBadge className="login-release" />
            <div className="px-9 pt-11">
              <div className="flex flex-col items-center text-center">
                <div className="-translate-x-3">
                  <BrandMark large />
                </div>
                <p className="mt-4 max-w-[22rem] text-center text-[13px] leading-6 text-text-secondary whitespace-pre-line">
                  {messages.login.description}
                </p>
                <Button className="mt-5 h-9 w-[70%] gap-2 text-[13px]" type="button" disabled={busy}>
                  <GoogleMark />
                  {messages.login.google}
                </Button>
                <p className="mt-3 text-[14px] font-medium leading-none tracking-wide text-text-tertiary">or</p>
                <div className="login-rule mt-3 w-full" />
              </div>
            </div>
            <form
              className="flex flex-col gap-5 px-9 pt-3"
              onSubmit={(event) => void onSubmit(event)}
            >
              <div className="flex flex-col gap-2.5">
                <FormField label={messages.login.userid}>
                  <div className="relative">
                    <UserRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-tertiary" />
                    <input
                      className="field-control login-field has-start-icon"
                      value={userid}
                      onChange={(event) => setUserid(event.target.value)}
                      autoComplete="username"
                    />
                  </div>
                </FormField>
                <FormField label={messages.login.password}>
                  <div className="relative">
                    <Lock className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-tertiary" />
                    <input
                      className="field-control login-field has-start-icon has-end-icon"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="current-password"
                    />
                    <button
                      className="absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-text-tertiary outline-none hover:bg-accent-subtle hover:text-accent"
                      type="button"
                      aria-label={
                        showPassword ? messages.login.hidePassword : messages.login.showPassword
                      }
                      title={
                        showPassword ? messages.login.hidePassword : messages.login.showPassword
                      }
                      onClick={() => setShowPassword((open) => !open)}
                    >
                      {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                </FormField>
              </div>
              <div className="flex items-center justify-between gap-3">
                <label className="flex min-w-0 cursor-pointer items-center gap-2 text-[12px] text-text-secondary">
                  <input
                    className="login-keep"
                    type="checkbox"
                    checked={keepLogin}
                    onChange={(event) => setKeepLogin(event.target.checked)}
                  />
                  {messages.login.keepLogin}
                </label>
                <button
                  className="login-link inline-flex shrink-0 items-center gap-1"
                  type="button"
                  disabled={busy}
                >
                  <KeyRound className="size-3.5" />
                  {messages.login.forgotPassword}
                </button>
              </div>
              <div className="mx-auto grid w-[88%] grid-cols-2 gap-3">
                <Button className="w-full" variant="primary" type="submit" disabled={busy}>
                  <LogIn className="size-3.5" />
                  {busy ? messages.login.authenticating : messages.login.submit}
                </Button>
                <Button className="w-full" variant="secondary" type="button" disabled={busy}>
                  <UserPlus className="size-3.5" />
                  {messages.login.signup}
                </Button>
              </div>
            </form>

            <p className="px-9 pb-9 pt-10 text-center text-xs text-text-tertiary">
              © {new Date().getFullYear()} {messages.login.footer}
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
