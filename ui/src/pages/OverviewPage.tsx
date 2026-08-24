import { Link } from "react-router-dom";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { LiveDot } from "@/components/LiveDot";
import { MetaField } from "@/components/MetaField";
import { NoticeBanner } from "@/components/NoticeBanner";
import { PageHeader, PageShell } from "@/components/PageShell";
import { Panel, PanelBody, PanelHeader } from "@/components/Panel";
import { StatusPill } from "@/components/StatusPill";
import { useOverviewData } from "@/hooks/useOverviewData";
import { fmtWhen } from "@/lib/format";
import { emptyCopy } from "@/mock/emptyStates";

export function OverviewPage() {
  const {
    systemHealth,
    recentJobs,
    recentExtracts,
    overviewError,
  } = useOverviewData();

  const runningJobs = recentJobs.filter((job) => job.status === "running").length;
  const activeExtracts = recentExtracts.filter(
    (extract) => extract.status === "queued" || extract.status === "running",
  ).length;
  const failures = recentJobs.filter((job) => job.status === "failed").length;

  return (
    <PageShell>
      <PageHeader
        iconName="overview"
        eyebrow="운영"
        title="개요"
        description="추출, 변환, 적재 작업의 현재 운영 상태입니다."
        actions={
          systemHealth ? (
            <LiveDot
              label={`${systemHealth.ok ? "서비스 정상" : "서비스 중단"} · v${systemHealth.version}`}
            />
          ) : null
        }
      />
      {overviewError ? <NoticeBanner>{overviewError}</NoticeBanner> : null}

      <Panel>
        <PanelHeader title="운영 요약" description="현재 세션에서 확인한 최근 상태" />
        <PanelBody className="flex items-start gap-6 py-3">
          <MetaField label="최근 작업">{recentJobs.length}</MetaField>
          <MetaField label="실행 중">{runningJobs}</MetaField>
          <MetaField label="추출 중">{activeExtracts}</MetaField>
          <MetaField label="실패">{failures}</MetaField>
        </PanelBody>
      </Panel>

      <Panel className="min-h-0 flex-1">
        <PanelHeader title="최근 작업" description="최근 생성된 작업 10건" />
        <DataGrid headers={["작업 ID", "상태", "소스", "생성 시각"]}>
          {recentJobs.length === 0 ? (
            <EmptyGridRow cols={4} text={emptyCopy.jobs} />
          ) : (
            recentJobs.map((job) => (
              <GridRow key={job.id}>
                <GridCell mono>
                  <Link className="font-medium hover:underline" to={`/jobs/${job.id}`}>
                    {job.id.slice(0, 8)}
                  </Link>
                </GridCell>
                <GridCell>
                  <StatusPill value={job.status} />
                </GridCell>
                <GridCell mono muted>{job.source_path}</GridCell>
                <GridCell mono muted>{fmtWhen(job.created_at)}</GridCell>
              </GridRow>
            ))
          )}
        </DataGrid>
      </Panel>
    </PageShell>
  );
}
