import { useCallback, useEffect, useState } from "react";
import { jobApi } from "@/services/jobApi";
import { useLanguage } from "@/i18n/LanguageProvider";
import { toastError } from "@/lib/notifications";
import type { EtlJobRun } from "@/types/job";

export function useJobRun(jobId?: string) {
  const { messages } = useLanguage();
  const [jobRun, setJobRun] = useState<EtlJobRun | null>(null);

  const refreshJobRun = useCallback(async () => {
    if (!jobId) return;
    setJobRun(await jobApi.getJobRun(jobId));
  }, [jobId]);

  useEffect(() => {
    void refreshJobRun().catch((error) =>
      toastError(messages.errors.job, error),
    );
    const timer = window.setInterval(() => {
      void refreshJobRun().catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [refreshJobRun, messages]);

  return { jobRun, refreshJobRun };
}
