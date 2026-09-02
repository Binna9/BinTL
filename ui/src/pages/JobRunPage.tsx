import { useParams } from "react-router-dom";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { StatusPill } from "@/components/StatusPill";
import { ActionAnchor, ActionLink, Button } from "@/components/ui/button";
import { MetaField } from "@/components/ui/meta-field";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { useJobRun } from "@/hooks/jobs/useJobRun";
import { useLanguage } from "@/i18n/LanguageProvider";
import { fmtWhen } from "@/lib/format";
import { toastError } from "@/lib/notifications";
import { jobApi } from "@/services/jobs/jobApi";

export function JobRunPage() {
  const { messages } = useLanguage();
  const { id } = useParams<{ id: string }>();
  const { jobRun, refreshJobRun } = useJobRun(id);

  async function run() {
    if (!id) return;
    try {
      await jobApi.runJob(id);
      await refreshJobRun();
    } catch (err) {
      toastError(messages.errors.runJob, err);
    }
  }

  if (!jobRun) {
    return (
      <PageShell>
        <p className="text-text-secondary">{messages.jobRun.loading}</p>
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
          <p className="border-t border-border px-3 py-2 text-[13px] text-danger">
            {jobRun.error_message}
          </p>
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
