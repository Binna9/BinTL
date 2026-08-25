import { useEffect, useState } from "react";
import { extractApi } from "@/services/extractApi";
import { useLanguage } from "@/i18n/LanguageProvider";
import { toastError } from "@/lib/notifications";
import type { ExtractRecord } from "@/types/extract";

export function isExtractActive(status: string): boolean {
  return status === "queued" || status === "running";
}

export function useExtracts() {
  const { messages } = useLanguage();
  const [extracts, setExtracts] = useState<ExtractRecord[]>([]);

  useEffect(() => {
    let timer: number | undefined;
    let cancelled = false;

    async function refreshExtracts() {
      try {
        const response = await extractApi.getExtracts();
        if (cancelled) return;
        setExtracts(response.extracts);
        if (response.extracts.some((extract) => isExtractActive(extract.status))) {
          timer = window.setTimeout(() => void refreshExtracts(), 2000);
        }
      } catch (error) {
        if (!cancelled) toastError(messages.errors.extracts, error);
      }
    }

    void refreshExtracts();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [messages]);

  return { extracts };
}
