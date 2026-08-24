import { useCallback, useEffect, useState } from "react";
import { jobApi } from "@/services/jobApi";
import type { EtlJobRun } from "@/types/job";

export function useJobRun(jobId?: string) {
  const [jobRun, setJobRun] = useState<EtlJobRun | null>(null);
  const [jobRunError, setJobRunError] = useState("");

  const refreshJobRun = useCallback(async () => {
    if (!jobId) return;
    setJobRun(await jobApi.getJobRun(jobId));
  }, [jobId]);

  useEffect(() => {
    void refreshJobRun().catch((error) =>
      setJobRunError(error instanceof Error ? error.message : "작업을 불러오지 못했습니다"),
    );
    const timer = window.setInterval(() => {
      void refreshJobRun().catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [refreshJobRun]);

  return { jobRun, jobRunError, setJobRunError, refreshJobRun };
}
