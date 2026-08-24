import { useEffect, useState } from "react";
import { extractApi } from "@/services/extractApi";
import type { ExtractRecord } from "@/types/extract";

export function isExtractActive(status: string): boolean {
  return status === "queued" || status === "running";
}

export function useExtracts() {
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
            error instanceof Error ? error.message : "추출 목록을 불러오지 못했습니다",
          );
        }
      }
    }

    void refreshExtracts();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  return { extracts, extractsError };
}
