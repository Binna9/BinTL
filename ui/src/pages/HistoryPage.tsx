import { Link } from "react-router-dom";
import { DataGrid, EmptyState, GridCell, GridRow } from "@/components/DataGrid";
import { NavIcon } from "@/components/ui/nav-icons";
import { PaginationBar } from "@/components/PaginationBar";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { StatusPill } from "@/components/StatusPill";
import { Panel } from "@/components/ui/panel";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { useJobWorkspace } from "@/hooks/jobs/useJobWorkspace";
import { useLanguage } from "@/i18n/LanguageProvider";
import { fmtWhen } from "@/lib/format";
import { usePagination } from "@/lib/pagination";

export function HistoryPage() {
  const { messages } = useLanguage();
  const { jobs } = useJobWorkspace();
  const paging = usePagination(jobs);

  return (
    <PageShell>
      <PageHeader
        iconName="history"
        eyebrow={messages.history.eyebrow}
        title={messages.history.title}
        description={messages.history.description}
      />
      <Panel>
        <Toolbar>
          <ToolbarGroup>
            <span className="text-[13px] font-semibold">{messages.jobs.history}</span>
            <span className="text-xs text-text-tertiary">{messages.common.cases(jobs.length)}</span>
          </ToolbarGroup>
        </Toolbar>
        <DataGrid
          headers={[...messages.jobs.headers]}
          empty={jobs.length === 0 ? <EmptyState icon={<NavIcon name="history" />} title={messages.empty.queue} hint={messages.empty.queueHint} /> : undefined}
        >
          {jobs.length === 0 ? null : paging.items.map((job) => (
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
            ))}
        </DataGrid>
        <PaginationBar
          page={paging.page}
          pageCount={paging.pageCount}
          pageSize={paging.pageSize}
          total={paging.total}
          start={paging.start}
          end={paging.end}
          onPageChange={paging.setPage}
          onPageSizeChange={paging.setPageSize}
        />
      </Panel>
    </PageShell>
  );
}
