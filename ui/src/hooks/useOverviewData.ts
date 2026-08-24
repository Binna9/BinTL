import { useEffect, useState } from "react";
import { extractApi } from "@/services/extractApi";
import { jobApi } from "@/services/jobApi";
import { systemApi } from "@/services/systemApi";
import { useLanguage } from "@/i18n/LanguageProvider";
import type { ExtractRecord } from "@/types/extract";
import type { EtlJob } from "@/types/job";
import type { SystemHealth } from "@/types/system";

export function useOverviewData() {
  const { messages } = useLanguage();
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null);
  const [recentJobs, setRecentJobs] = useState<EtlJob[]>([]);
  const [recentExtracts, setRecentExtracts] = useState<ExtractRecord[]>([]);
  const [overviewError, setOverviewError] = useState("");

  useEffect(() => {
    void Promise.all([
      systemApi.getHealth(),
      jobApi.getJobs(10),
      extractApi.getExtracts(50),
    ])
      .then(([healthResponse, jobResponse, extractResponse]) => {
        setSystemHealth(healthResponse);
        setRecentJobs(jobResponse.jobs);
        setRecentExtracts(extractResponse.extracts);
      })
      .catch((error) =>
        setOverviewError(
          error instanceof Error ? error.message : messages.errors.overview,
        ),
      );
  }, [messages]);

  return { systemHealth, recentJobs, recentExtracts, overviewError };
}
