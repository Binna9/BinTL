import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { ActionAnchor, ActionLink, Button } from "@/components/Button";
import { MetaField } from "@/components/MetaField";
import { NoticeBanner } from "@/components/NoticeBanner";
import { PageHeader, PageShell } from "@/components/PageShell";
import { Panel, PanelBody, PanelHeader } from "@/components/Panel";
import { StatusPill } from "@/components/StatusPill";
import { api, resultUrl } from "@/lib/api";
import { fmtWhen } from "@/lib/format";
import { emptyCopy } from "@/mock/emptyStates";
import type { JobRun } from "@/types/pipeline";

export function JobRunPage() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<JobRun | null>(null);
  const [error, setError] = useState("");

  async function refresh() {
    if (!id) return;
    setJob(await api.job(id));
  }

  useEffect(() => {
    void refresh().catch((err) =>
      setError(err instanceof Error ? err.message : "작업을 불러오지 못했습니다"),
    );
    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [id]);

  async function run() {
    if (!id) return;
    setError("");
    try {
      await api.runJob(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "작업 실행에 실패했습니다");
    }
  }

  if (!job) {
    return (
      <PageShell>
        {error ? <NoticeBanner>{error}</NoticeBanner> : <p className="text-text-secondary">작업을 불러오는 중입니다…</p>}
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        iconName="jobs"
        eyebrow="작업 / 실행 상세"
        title={`작업 ${job.id.slice(0, 8)}`}
        description={`${job.source_path} → ${job.output_path ?? "출력 대기 중"}`}
        actions={
          <>
            <ActionLink to="/jobs">목록으로</ActionLink>
            <Button
              variant="primary"
              type="button"
              onClick={() => void run()}
              disabled={job.status === "running"}
            >
              실행
            </Button>
            {job.status === "succeeded" ? (
              <ActionAnchor href={resultUrl(job.id)}>결과 다운로드</ActionAnchor>
            ) : null}
          </>
        }
      />
      {error ? <NoticeBanner>{error}</NoticeBanner> : null}

      <Panel>
        <PanelHeader title="실행 정보" />
        <PanelBody className="flex flex-wrap gap-5 py-3">
          <MetaField label="상태">
            <StatusPill value={job.status} />
          </MetaField>
          <MetaField label="생성" technical>{fmtWhen(job.created_at)}</MetaField>
          <MetaField label="시작" technical>
            {job.started_at ? fmtWhen(job.started_at) : "—"}
          </MetaField>
          <MetaField label="종료" technical>
            {job.finished_at ? fmtWhen(job.finished_at) : "—"}
          </MetaField>
          <MetaField label="작업 ID" technical>{job.id}</MetaField>
        </PanelBody>
        {job.error_message ? (
          <div className="border-t border-border p-3">
            <NoticeBanner>{job.error_message}</NoticeBanner>
          </div>
        ) : null}
      </Panel>

      <Panel className="min-h-0 flex-1">
        <PanelHeader title="실행 로그" description="작업 상태는 1.5초마다 갱신됩니다." />
        <pre className="m-0 h-[calc(100vh-22rem)] min-h-72 overflow-auto bg-[#171a1f] p-4 font-sans text-[12px] leading-5 text-[#d7dce2]">
          {job.logs.map((log) => `${fmtWhen(log.ts)}  ${log.level.padEnd(5)}  ${log.message}`).join("\n") ||
            emptyCopy.logs}
        </pre>
      </Panel>
    </PageShell>
  );
}
