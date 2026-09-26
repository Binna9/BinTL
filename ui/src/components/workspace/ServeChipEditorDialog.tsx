import { useEffect, useState } from "react";
import { Copy, Globe, RefreshCw } from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Select } from "@/components/ui/select";
import { useLanguage } from "@/i18n/LanguageProvider";
import { toastError, toastSuccess } from "@/lib/notifications";
import { isChipNameConflict } from "@/services/httpClient";
import { chipApi } from "@/services/chips/chipApi";
import type { Chip } from "@/types/chip";

export function newServeApiKey() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `btl_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function slugFromName(name: string) {
  return name.trim().replace(/\s+/g, "-").replace(/[/\\?#&=%]/g, "").slice(0, 64);
}

function serveFields(chip: Chip | null): { slug: string; freshness: "slot" | "live"; apiKey: string } {
  const config = chip?.config ?? {};
  const slug = typeof config.slug === "string" ? config.slug : "";
  const freshness = config.freshness === "live" ? "live" : "slot";
  const apiKey = typeof config.api_key === "string" && config.api_key
    ? config.api_key
    : chip?.api_key ?? "";
  return { slug, freshness, apiKey };
}

export function ServeChipEditorDialog({
  open,
  chip,
  onClose,
  onSaved,
}: {
  open: boolean;
  chip: Chip | null;
  onClose: () => void;
  onSaved: (chip: Chip) => void;
}) {
  const { messages } = useLanguage();
  const [slug, setSlug] = useState("");
  const [freshness, setFreshness] = useState<"slot" | "live">("slot");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const saved = serveFields(chip);
    setSlug(saved.slug || slugFromName(chip?.name ?? ""));
    setFreshness(saved.freshness);
    setApiKey(saved.apiKey);
    setBusy(false);
  }, [chip, open]);

  const canSave = Boolean(chip) && Boolean(slug.trim()) && !busy;

  async function copy(value: string, ok: string) {
    try {
      await navigator.clipboard.writeText(value);
      toastSuccess(ok);
    } catch {
      toastError(messages.workspace.saveChipError);
    }
  }

  async function save() {
    if (!chip || !canSave) return;
    setBusy(true);
    const config: Record<string, unknown> = { slug: slug.trim(), freshness };
    if (apiKey.trim()) config.api_key = apiKey.trim();
    try {
      const saved = await chipApi.update(chip.id, { config });
      if (saved.api_key) setApiKey(saved.api_key);
      toastSuccess(messages.workspace.serveChipSaved);
      onSaved({ ...saved, api_key: saved.api_key ?? (apiKey.trim() || undefined) });
    } catch (error) {
      toastError(
        isChipNameConflict(error) ? messages.workspace.duplicateChipName : messages.workspace.saveChipError,
        isChipNameConflict(error) ? undefined : error,
      );
    } finally {
      setBusy(false);
    }
  }

  const path = messages.workspace.servePathPreview(slug.trim());

  return (
    <AppDialog
      open={open}
      title={messages.workspace.editServeChipTitle}
      icon={<Globe className="size-4 text-teal-600 dark:text-teal-400" aria-hidden="true" />}
      className="w-[min(28rem,92vw)]"
      minWidth={360}
      minHeight={420}
      zIndex={130}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            {messages.common.cancel}
          </Button>
          <Button type="button" variant="primary" disabled={!canSave} onClick={() => void save()}>
            {busy ? messages.common.saving : messages.common.save}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-4">
        <FormField
          label={messages.workspace.serveSlug}
          example={messages.workspace.serveSlugExample}
          hint={messages.workspace.serveSlugHint}
        >
          <input
            className="field-control"
            value={slug}
            placeholder={messages.workspace.serveSlugPlaceholder}
            disabled={busy}
            onChange={(event) => setSlug(event.target.value)}
          />
        </FormField>
        {slug.trim() ? (
          <p className="font-mono text-[11px] text-text-secondary">{messages.workspace.servePathLabel(slug.trim())}</p>
        ) : null}
        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="h-8 gap-1.5 px-2 text-[11px]" onClick={() => void copy(path, messages.workspace.serveCopied)}>
            <Copy className="size-3.5" aria-hidden="true" />
            {messages.workspace.serveCopyPath}
          </Button>
        </div>
        <FormField label={messages.workspace.serveFreshness}>
          <Select
            value={freshness}
            disabled={busy}
            options={[
              { value: "slot", label: messages.workspace.serveFreshnessSlot },
              { value: "live", label: messages.workspace.serveFreshnessLive },
            ]}
            onChange={(value) => setFreshness(value === "live" ? "live" : "slot")}
          />
        </FormField>
        <FormField
          label={messages.workspace.serveApiKey}
          hint={apiKey ? messages.workspace.serveApiKeyHint : messages.workspace.serveApiKeySaved}
        >
          {apiKey ? (
            <input className="field-control font-mono text-[12px]" value={apiKey} readOnly />
          ) : null}
        </FormField>
        <div className="flex flex-wrap gap-2">
          {apiKey ? (
            <Button type="button" variant="secondary" className="h-8 gap-1.5 px-2 text-[11px]" onClick={() => void copy(apiKey, messages.workspace.serveCopied)}>
              <Copy className="size-3.5" aria-hidden="true" />
              {messages.workspace.serveCopyKey}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            className="h-8 gap-1.5 px-2 text-[11px]"
            disabled={busy}
            onClick={() => setApiKey(newServeApiKey())}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {messages.workspace.serveRotateKey}
          </Button>
        </div>
      </div>
    </AppDialog>
  );
}
