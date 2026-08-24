import { useEffect, useState } from "react";
import { extractApi } from "@/services/extractApi";
import { useLanguage } from "@/i18n/LanguageProvider";
import type { ExtractRecord } from "@/types/extract";

export function isExtractActive(status: string): boolean {
  return status === "queued" || status === "running";
}

export function useExtracts() {
  const { messages } = useLanguage();
  const [extracts, setExtracts] = useState<ExtractRecord[]>([]);
  const [extractsError, setExtractsError] = useState("");

  useEffect(() => {
    let timer: number | undefined;
    let cancelled = false;

    async function refreshExtracts() {
      try {
        const response = await extractApi.getExtracts();
        if (cancelled) return;
        setExtracts(response.extracts);
        setExtractsError("");
        if (response.extracts.some((extract) => isExtractActive(extract.status))) {
          timer = window.setTimeout(() => void refreshExtracts(), 2000);
        }
      } catch (error) {
        if (!cancelled) {
          setExtractsError(
            error instanceof Error ? error.message : messages.errors.extracts,
          );
        }
      }
    }

    void refreshExtracts();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [messages]);

  return { extracts, extractsError };
}
