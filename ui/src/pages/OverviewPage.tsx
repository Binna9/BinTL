import { Link } from "react-router-dom";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { PageHeader, PageShell } from "@/components/PageShell";
import { StatusPill } from "@/components/StatusPill";
import { LiveDot } from "@/components/ui/live-dot";
import { MetaField } from "@/components/ui/meta-field";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { useOverviewData } from "@/hooks/useOverviewData";
import { useLanguage } from "@/i18n/LanguageProvider";
import { fmtWhen } from "@/lib/format";

export function OverviewPage() {
  const { messages } = useLanguage();
  const {
    systemHealth,
    recentJobs,
    recentExtracts,
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
        eyebrow={messages.overview.eyebrow}
        title={messages.overview.title}
        description={messages.overview.description}
        actions={
          systemHealth ? (
            <LiveDot
              label={`${systemHealth.ok ? messages.overview.healthy : messages.overview.down} · v${systemHealth.version}`}
            />
          ) : null
        }
      />

      <Panel>
        <PanelHeader title={messages.overview.summary} description={messages.overview.summaryDescription} />
        <PanelBody className="flex items-start gap-6 py-3">
          <MetaField label={messages.overview.recentJobs}>{recentJobs.length}</MetaField>
          <MetaField label={messages.overview.running}>{runningJobs}</MetaField>
          <MetaField label={messages.overview.extracting}>{activeExtracts}</MetaField>
          <MetaField label={messages.overview.failed}>{failures}</MetaField>
        </PanelBody>
      </Panel>

      <Panel tall>
        <PanelHeader title={messages.overview.recentJobs} description={messages.overview.recentDescription} />
        <DataGrid className="min-h-0 flex-1" headers={[...messages.overview.headers]}>
          {recentJobs.length === 0 ? (
            <EmptyGridRow cols={4} text={messages.empty.jobs} />
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
