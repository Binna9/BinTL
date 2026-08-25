import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BrandMark } from "@/components/BrandMark";
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
    <main className="grid min-h-screen grid-cols-[minmax(20rem,32rem)_1fr] bg-workspace">
      <section className="flex flex-col justify-between border-r border-border bg-surface p-10">
        <BrandMark />

        <div className="max-w-80">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-text-tertiary">
            {messages.login.platform}
          </p>
          <h1 className="text-xl font-semibold tracking-[-0.015em]">{messages.login.title}</h1>
          <p className="mt-2 text-[13px] leading-5 text-text-secondary">
            {messages.login.description}
          </p>
          <form className="mt-7 flex flex-col gap-4" onSubmit={(event) => void onSubmit(event)}>
            <FormField label={messages.login.username}>
              <input
                className="field-control"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
              />
            </FormField>
            <FormField label={messages.login.password}>
              <input
                className="field-control"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
              />
            </FormField>
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? messages.login.authenticating : messages.login.submit}
            </Button>
          </form>
        </div>

        <p className="text-xs text-text-tertiary">{messages.login.footer}</p>
      </section>
      <div className="bg-workspace" />
    </main>
  );
}
