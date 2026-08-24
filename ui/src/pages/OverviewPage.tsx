import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { LiveDot } from "@/components/LiveDot";
import { MetaField } from "@/components/MetaField";
import { NoticeBanner } from "@/components/NoticeBanner";
import { PageHeader, PageShell } from "@/components/PageShell";
import { Panel, PanelBody, PanelHeader } from "@/components/Panel";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { fmtWhen } from "@/lib/format";
import { emptyCopy } from "@/mock/emptyStates";
import type { ExtractItem, Health, Job } from "@/types/pipeline";

export function OverviewPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [extracts, setExtracts] = useState<ExtractItem[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const [healthResult, jobResult, extractResult] = await Promise.all([
          api.health(),
          api.jobs(10),
          api.extracts(50),
        ]);
        setHealth(healthResult);
        setJobs(jobResult.jobs);
        setExtracts(extractResult.extracts);
      } catch (err) {
        setError(err instanceof Error ? err.message : "운영 정보를 불러오지 못했습니다");
      }
    })();
  }, []);

  const runningJobs = jobs.filter((job) => job.status === "running").length;
  const activeExtracts = extracts.filter(
    (extract) => extract.status === "queued" || extract.status === "running",
  ).length;
  const failures = jobs.filter((job) => job.status === "failed").length;

  return (
    <PageShell>
      <PageHeader
        iconName="overview"
        eyebrow="운영"
        title="개요"
        description="추출, 변환, 적재 작업의 현재 운영 상태입니다."
        actions={
          health ? (
            <LiveDot label={`${health.ok ? "서비스 정상" : "서비스 중단"} · v${health.version}`} />
          ) : null
        }
      />
      {error ? <NoticeBanner>{error}</NoticeBanner> : null}

      <Panel>
        <PanelHeader title="운영 요약" description="현재 세션에서 확인한 최근 상태" />
        <PanelBody className="flex items-start gap-6 py-3">
          <MetaField label="최근 작업">{jobs.length}</MetaField>
          <MetaField label="실행 중">{runningJobs}</MetaField>
          <MetaField label="추출 중">{activeExtracts}</MetaField>
          <MetaField label="실패">{failures}</MetaField>
        </PanelBody>
      </Panel>

      <Panel className="min-h-0 flex-1">
        <PanelHeader title="최근 작업" description="최근 생성된 작업 10건" />
        <DataGrid headers={["작업 ID", "상태", "소스", "생성 시각"]}>
          {jobs.length === 0 ? (
            <EmptyGridRow cols={4} text={emptyCopy.jobs} />
          ) : (
            jobs.map((job) => (
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
