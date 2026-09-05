import { Camera, KeyRound, LoaderCircle, Pencil, ShieldCheck, UserRound } from "lucide-react";
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { AppDialog } from "@/components/AppDialog";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { useSession } from "@/hooks/auth/useSession";
import { useLanguage } from "@/i18n/LanguageProvider";
import { toastError, toastSuccess } from "@/lib/notifications";
import { userApi } from "@/services/auth/userApi";

function resizeProfileImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const size = 320;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      if (!context) {
        URL.revokeObjectURL(url);
        reject(new Error("Canvas is not available"));
        return;
      }
      const scale = Math.max(size / image.naturalWidth, size / image.naturalHeight);
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.84));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Invalid image"));
    };
    image.src = url;
  });
}

export function AccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { messages } = useLanguage();
  const { user, refresh } = useSession();
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"view" | "profile" | "password">("view");
  const [username, setUsername] = useState("");
  const [avatar, setAvatar] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !user) return;
    setMode("view");
    setUsername(user.username);
    setAvatar(user.avatar_data_url ?? null);
  }, [open, user]);

  async function chooseImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toastError(messages.nav.profileImageError);
      return;
    }
    try {
      setAvatar(await resizeProfileImage(file));
      setMode("profile");
    } catch (error) {
      toastError(messages.nav.profileImageError, error);
    }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) return;
    setBusy(true);
    try {
      await userApi.updateProfile(username, avatar);
      await refresh();
      toastSuccess(messages.nav.profileSaved);
      setMode("view");
    } catch (error) {
      toastError(messages.nav.profileSaveError, error);
    } finally {
      setBusy(false);
    }
  }

  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword") ?? "");
    const newPassword = String(data.get("newPassword") ?? "");
    const confirmPassword = String(data.get("confirmPassword") ?? "");
    if (newPassword.length < 8) {
      toastError(messages.nav.passwordRule);
      return;
    }
    if (newPassword !== confirmPassword) {
      toastError(messages.nav.passwordMismatch);
      return;
    }
    if (!currentPassword) {
      toastError(messages.nav.currentPasswordRequired);
      return;
    }
    setBusy(true);
    try {
      await userApi.changePassword(currentPassword, newPassword);
      form.reset();
      toastSuccess(messages.nav.passwordChanged);
      setMode("view");
    } catch (error) {
      toastError(messages.nav.passwordChangeError, error);
    } finally {
      setBusy(false);
    }
  }

  if (!user) return null;
  const initial = (user.username || user.userid).trim().slice(0, 1).toUpperCase();

  return (
    <AppDialog
      open={open}
      title={<span className="text-base">{messages.nav.accountInfo}</span>}
      icon={<UserRound className="size-5 text-accent" aria-hidden="true" />}
      className="h-[min(29rem,84vh)] w-[min(44rem,92vw)]"
      minWidth={580}
      minHeight={390}
      onClose={onClose}
    >
      <div className="grid min-h-0 flex-1 grid-cols-[13rem_1px_1fr] bg-surface">
        <aside className="flex flex-col items-center bg-raised/70 px-5 py-6 text-center">
          <button
            type="button"
            className="group relative grid size-24 place-items-center overflow-hidden rounded-full border-[3px] border-surface bg-accent text-2xl font-bold text-white shadow-[0_8px_22px_rgba(15,23,42,0.16)] outline-none ring-1 ring-border transition hover:-translate-y-0.5 hover:ring-accent focus-visible:ring-2 focus-visible:ring-accent"
            onClick={() => fileRef.current?.click()}
            aria-label={messages.nav.chooseProfileImage}
          >
            {avatar ? <img src={avatar} alt="" className="size-full object-cover" /> : initial}
            <span className="absolute inset-0 grid place-items-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100">
              <Camera className="size-5" aria-hidden="true" />
            </span>
          </button>
          <input ref={fileRef} className="hidden" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void chooseImage(event)} />
          <button type="button" className="mt-2 rounded-lg px-2 py-1 text-[11px] font-semibold text-accent transition-colors hover:bg-accent-subtle" onClick={() => fileRef.current?.click()}>
            {messages.nav.changePhoto}
          </button>
          <h3 className="mt-3 max-w-full truncate text-base font-bold text-text">{user.username}</h3>
          <p className="mt-1 text-xs text-text-tertiary">@{user.userid}</p>
          <span className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-success/20 bg-success-subtle px-2.5 py-1 text-[10px] font-semibold text-success">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            {user.active ? messages.nav.activeAccount : messages.nav.inactiveAccount}
          </span>
          <p className="mt-auto text-[10px] leading-4 text-text-tertiary">{messages.nav.profileImageHint}</p>
        </aside>
        <div className="bg-border" aria-hidden="true" />
        <main className="min-h-0 overflow-y-auto p-6">
          {mode === "view" ? (
            <div className="mx-auto max-w-xl">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-base font-bold text-text">{messages.nav.basicInformation}</h3>
                  <p className="mt-1 text-xs text-text-tertiary">{messages.nav.basicInformationDesc}</p>
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="quiet" onClick={() => setMode("password")}><KeyRound className="size-3.5" aria-hidden="true" />{messages.nav.passwordReset}</Button>
                  <Button type="button" variant="primary" onClick={() => setMode("profile")}><Pencil className="size-3.5" aria-hidden="true" />{messages.common.edit}</Button>
                </div>
              </div>
              <dl className="mt-5 overflow-hidden rounded-xl border border-border bg-raised/40">
                {[
                  [messages.nav.accountId, user.userid],
                  [messages.settings.username, user.username],
                  [messages.nav.accountRole, user.roles.join(", ") || "-"],
                  [messages.nav.accountStatus, user.active ? messages.nav.activeAccount : messages.nav.inactiveAccount],
                ].map(([label, value]) => (
                  <div key={label} className="grid grid-cols-[7rem_1fr] border-b border-border px-4 py-3 last:border-b-0">
                    <dt className="text-xs font-medium text-text-tertiary">{label}</dt>
                    <dd className="text-sm font-semibold text-text">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : mode === "profile" ? (
            <form className="mx-auto max-w-xl" onSubmit={(event) => void saveProfile(event)}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-base font-bold text-text">{messages.nav.editProfile}</h3>
                  <p className="mt-1 text-xs text-text-tertiary">{messages.nav.editProfileDesc}</p>
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="quiet" disabled={busy} onClick={() => { setUsername(user.username); setAvatar(user.avatar_data_url ?? null); setMode("view"); }}>
                    {messages.common.cancel}
                  </Button>
                  <Button type="submit" variant="primary" disabled={busy || !username.trim()}>
                    {busy ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : null}
                    {busy ? messages.common.saving : messages.common.save}
                  </Button>
                </div>
              </div>
              <div className="mt-5 space-y-4">
                <FormField label={messages.nav.accountId} hint={messages.nav.accountIdReadonly}>
                  <input className="field-control" value={user.userid} disabled />
                </FormField>
                <FormField label={messages.settings.username}>
                  <input className="field-control" value={username} maxLength={80} onChange={(event) => setUsername(event.target.value)} required />
                </FormField>
              </div>
            </form>
          ) : (
            <form className="mx-auto max-w-xl" onSubmit={(event) => void savePassword(event)}>
              <div className="flex items-start justify-between gap-4">
                <div><h3 className="text-base font-bold text-text">{messages.nav.passwordReset}</h3><p className="mt-1 text-xs text-text-tertiary">{messages.nav.passwordRule}</p></div>
                <div className="flex gap-2">
                  <Button type="button" variant="quiet" disabled={busy} onClick={() => setMode("view")}>{messages.common.cancel}</Button>
                  <Button type="submit" variant="primary" disabled={busy}>{busy ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <KeyRound className="size-3.5" aria-hidden="true" />}{busy ? messages.common.saving : messages.nav.passwordReset}</Button>
                </div>
              </div>
              <div className="mt-5 space-y-4 rounded-xl border border-border bg-raised/40 p-4">
                <FormField label={messages.nav.currentPassword}><input className="field-control" name="currentPassword" type="password" autoComplete="current-password" required autoFocus /></FormField>
                <div className="grid grid-cols-2 gap-3">
                  <FormField label={messages.nav.newPassword}><input className="field-control" name="newPassword" type="password" autoComplete="new-password" minLength={8} required /></FormField>
                  <FormField label={messages.nav.confirmPassword}><input className="field-control" name="confirmPassword" type="password" autoComplete="new-password" minLength={8} required /></FormField>
                </div>
              </div>
            </form>
          )}
        </main>
      </div>
    </AppDialog>
  );
}
