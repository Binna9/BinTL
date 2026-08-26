import { FormEvent, useState } from "react";
import { Eye, EyeOff, KeyRound, Lock, LogIn, UserPlus, UserRound } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { BrandMark } from "@/components/BrandMark";
import { TopSubmenu } from "@/components/TopSubmenu";
import { ShaderBackground } from "@/components/ui/adisyon-shader";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { useLanguage } from "@/i18n/LanguageProvider";
import { toastError } from "@/lib/notifications";
import { authApi } from "@/services/authApi";

export function SessionGatePage() {
  const { messages } = useLanguage();
  const navigate = useNavigate();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("admin");
  const [busy, setBusy] = useState(false);
  const [keepLogin, setKeepLogin] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await authApi.login(username, password);
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
        <section className="login-card relative flex w-full max-w-[30rem] flex-col overflow-hidden rounded-2xl border border-border bg-surface/95 shadow-[3px_4px_8px_-5px_rgba(15,23,42,0.35)] backdrop-blur-[2px] dark:shadow-[3px_4px_10px_-5px_rgba(0,0,0,0.65)]">
          <div className="px-9 pt-11">
            <div className="flex flex-col items-center text-center">
              <div className="-translate-x-3">
                <BrandMark large />
              </div>
              <p className="mt-5 min-h-10 text-center text-[13px] leading-5 text-text-secondary">
                {messages.login.description}
              </p>
            </div>
          </div>
          <div className="px-9 pt-8">
            <div className="login-rule" />
          </div>
          <form
            className="flex flex-col gap-5 px-9 pt-8"
            onSubmit={(event) => void onSubmit(event)}
          >
              <div className="flex flex-col gap-2.5">
                <FormField label={messages.login.username}>
                  <div className="relative">
                    <UserRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-tertiary" />
                    <input
                      className="field-control login-field has-start-icon"
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
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
              <div className="grid w-full grid-cols-2 gap-3">
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
    </main>
  );
}
