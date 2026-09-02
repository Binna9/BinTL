import { Link } from "react-router-dom";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { StatusPill } from "@/components/StatusPill";
import { Panel } from "@/components/ui/panel";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { useJobWorkspace } from "@/hooks/jobs/useJobWorkspace";
import { useLanguage } from "@/i18n/LanguageProvider";
import { fmtWhen } from "@/lib/format";

export function HistoryPage() {
  const { messages } = useLanguage();
  const { jobs } = useJobWorkspace();

  return (
    <PageShell>
      <PageHeader
        iconName="jobs"
        eyebrow={messages.history.eyebrow}
        title={messages.history.title}
        description={messages.history.description}
      />
      <Panel tall>
        <Toolbar>
          <ToolbarGroup>
            <span className="text-[13px] font-semibold">{messages.jobs.history}</span>
            <span className="text-xs text-text-tertiary">{messages.common.cases(jobs.length)}</span>
          </ToolbarGroup>
        </Toolbar>
        <DataGrid className="min-h-0 flex-1" headers={[...messages.jobs.headers]}>
          {jobs.length === 0 ? (
            <EmptyGridRow cols={4} text={messages.empty.queue} />
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
                <GridCell mono muted>
                  {job.source_path}
                </GridCell>
                <GridCell mono muted>
                  {fmtWhen(job.created_at)}
                </GridCell>
              </GridRow>
            ))
          )}
        </DataGrid>
      </Panel>
    </PageShell>
  );
}
