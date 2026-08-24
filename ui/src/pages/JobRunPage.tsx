import { useParams } from "react-router-dom";
import { ActionAnchor, ActionLink, Button } from "@/components/Button";
import { MetaField } from "@/components/MetaField";
import { NoticeBanner } from "@/components/NoticeBanner";
import { PageHeader, PageShell } from "@/components/PageShell";
import { Panel, PanelBody, PanelHeader } from "@/components/Panel";
import { StatusPill } from "@/components/StatusPill";
import { useJobRun } from "@/hooks/useJobRun";
import { fmtWhen } from "@/lib/format";
import { emptyCopy } from "@/mock/emptyStates";
import { jobApi } from "@/services/jobApi";

export function JobRunPage() {
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
      setJobRunError(err instanceof Error ? err.message : "작업 실행에 실패했습니다");
    }
  }

  if (!jobRun) {
    return (
      <PageShell>
        {jobRunError ? (
          <NoticeBanner>{jobRunError}</NoticeBanner>
        ) : (
          <p className="text-text-secondary">작업을 불러오는 중입니다…</p>
        )}
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        iconName="jobs"
        eyebrow="작업 / 실행 상세"
        title={`작업 ${jobRun.id.slice(0, 8)}`}
        description={`${jobRun.source_path} → ${jobRun.output_path ?? "출력 대기 중"}`}
        actions={
          <>
            <ActionLink to="/jobs">목록으로</ActionLink>
            <Button
              variant="primary"
              type="button"
              onClick={() => void run()}
              disabled={jobRun.status === "running"}
            >
              실행
            </Button>
            {jobRun.status === "succeeded" ? (
              <ActionAnchor href={jobApi.getResultUrl(jobRun.id)}>결과 다운로드</ActionAnchor>
            ) : null}
          </>
        }
      />
      {jobRunError ? <NoticeBanner>{jobRunError}</NoticeBanner> : null}

      <Panel>
        <PanelHeader title="실행 정보" />
        <PanelBody className="flex flex-wrap gap-5 py-3">
          <MetaField label="상태">
            <StatusPill value={jobRun.status} />
          </MetaField>
          <MetaField label="생성" technical>{fmtWhen(jobRun.created_at)}</MetaField>
          <MetaField label="시작" technical>
            {jobRun.started_at ? fmtWhen(jobRun.started_at) : "—"}
          </MetaField>
          <MetaField label="종료" technical>
            {jobRun.finished_at ? fmtWhen(jobRun.finished_at) : "—"}
          </MetaField>
          <MetaField label="작업 ID" technical>{jobRun.id}</MetaField>
        </PanelBody>
        {jobRun.error_message ? (
          <div className="border-t border-border p-3">
            <NoticeBanner>{jobRun.error_message}</NoticeBanner>
          </div>
        ) : null}
      </Panel>

      <Panel className="min-h-0 flex-1">
        <PanelHeader title="실행 로그" description="작업 상태는 1.5초마다 갱신됩니다." />
        <pre className="m-0 h-[calc(100vh-22rem)] min-h-72 overflow-auto bg-[#171a1f] p-4 font-sans text-[12px] leading-5 text-[#d7dce2]">
          {jobRun.logs.map((log) => `${fmtWhen(log.ts)}  ${log.level.padEnd(5)}  ${log.message}`).join("\n") ||
            emptyCopy.logs}
        </pre>
      </Panel>
    </PageShell>
  );
}
