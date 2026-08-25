import { useParams } from "react-router-dom";
import { PageHeader, PageShell } from "@/components/PageShell";
import { StatusPill } from "@/components/StatusPill";
import { ActionAnchor, ActionLink, Button } from "@/components/ui/button";
import { MetaField } from "@/components/ui/meta-field";
import { NoticeBanner } from "@/components/ui/notice-banner";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { useJobRun } from "@/hooks/useJobRun";
import { useLanguage } from "@/i18n/LanguageProvider";
import { fmtWhen } from "@/lib/format";
import { jobApi } from "@/services/jobApi";

export function JobRunPage() {
  const { messages } = useLanguage();
  const { id } = useParams<{ id: string }>();
  const {
    jobRun,
    jobRunError,
    setJobRunError,
    refreshJobRun,
  } = useJobRun(id);

  async function run() {
    if (!id) return;
    setJobRunError("");
    try {
      await jobApi.runJob(id);
      await refreshJobRun();
    } catch (err) {
      setJobRunError(err instanceof Error ? err.message : messages.errors.runJob);
    }
  }

  if (!jobRun) {
    return (
      <PageShell>
        {jobRunError ? (
          <NoticeBanner>{jobRunError}</NoticeBanner>
        ) : (
          <p className="text-text-secondary">{messages.jobRun.loading}</p>
        )}
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        iconName="jobs"
        eyebrow={messages.jobRun.eyebrow}
        title={messages.jobRun.title(jobRun.id.slice(0, 8))}
        description={`${jobRun.source_path} → ${jobRun.output_path ?? messages.jobRun.outputPending}`}
        actions={
          <>
            <ActionLink to="/history">{messages.jobRun.back}</ActionLink>
            <Button
              variant="primary"
              type="button"
              onClick={() => void run()}
              disabled={jobRun.status === "running"}
            >
              {messages.common.run}
            </Button>
            {jobRun.status === "succeeded" ? (
              <ActionAnchor href={jobApi.getResultUrl(jobRun.id)}>{messages.jobRun.resultDownload}</ActionAnchor>
            ) : null}
          </>
        }
      />
      {jobRunError ? <NoticeBanner>{jobRunError}</NoticeBanner> : null}

      <Panel>
        <PanelHeader title={messages.jobRun.info} />
        <PanelBody className="flex flex-wrap gap-5 py-3">
          <MetaField label={messages.jobRun.status}>
            <StatusPill value={jobRun.status} />
          </MetaField>
          <MetaField label={messages.jobRun.created} technical>{fmtWhen(jobRun.created_at)}</MetaField>
          <MetaField label={messages.jobRun.started} technical>
            {jobRun.started_at ? fmtWhen(jobRun.started_at) : "—"}
          </MetaField>
          <MetaField label={messages.jobRun.finished} technical>
            {jobRun.finished_at ? fmtWhen(jobRun.finished_at) : "—"}
          </MetaField>
          <MetaField label={messages.jobRun.jobId} technical>{jobRun.id}</MetaField>
        </PanelBody>
        {jobRun.error_message ? (
          <div className="border-t border-border p-3">
            <NoticeBanner>{jobRun.error_message}</NoticeBanner>
          </div>
        ) : null}
      </Panel>

      <Panel tall>
        <PanelHeader title={messages.jobRun.logs} description={messages.jobRun.refresh} />
        <pre className="m-0 min-h-0 flex-1 overflow-auto bg-[#171a1f] p-4 font-sans text-[12px] leading-5 text-[#d7dce2]">
          {jobRun.logs.map((log) => `${fmtWhen(log.ts)}  ${log.level.padEnd(5)}  ${log.message}`).join("\n") ||
            messages.empty.logs}
        </pre>
      </Panel>
    </PageShell>
  );
}
