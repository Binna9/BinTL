import { useCallback, useEffect, useState } from "react";
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

  const refreshExtracts = useCallback(async () => {
    const response = await extractApi.getExtracts();
    setExtracts(response.extracts);
    return response.extracts;
  }, []);

  useEffect(() => {
    let timer: number | undefined;
    let cancelled = false;

    async function poll() {
      try {
        const next = await extractApi.getExtracts(50, { silent: true });
        if (cancelled) return;
        setExtracts(next.extracts);
        if (next.extracts.some((extract) => isExtractActive(extract.status))) {
          timer = window.setTimeout(() => void poll(), 2000);
        }
      } catch (error) {
        if (!cancelled) toastError(messages.errors.extracts, error);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [messages]);

  return { extracts, refreshExtracts };
}
