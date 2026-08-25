import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { PageHeader, PageShell } from "@/components/PageShell";
import { StatusPill } from "@/components/StatusPill";
import { ActionAnchor } from "@/components/ui/button";
import { LiveDot } from "@/components/ui/live-dot";
import { NoticeBanner } from "@/components/ui/notice-banner";
import { Panel } from "@/components/ui/panel";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { isExtractActive, useExtracts } from "@/hooks/useExtracts";
import { useLanguage } from "@/i18n/LanguageProvider";
import { fmtDelimiter, fmtSqlPreview, fmtWhen } from "@/lib/format";
import { extractApi } from "@/services/extractApi";

export function ExtractResultsPage() {
  const { messages } = useLanguage();
  const { extracts, extractsError } = useExtracts();
  const activeCount = extracts.filter((extract) => isExtractActive(extract.status)).length;

  return (
    <PageShell>
      <PageHeader
        iconName="extracts"
        eyebrow={messages.extracts.eyebrow}
        title={messages.extracts.title}
        description={messages.extracts.description}
        actions={activeCount > 0 ? <LiveDot label={messages.extracts.generating(activeCount)} /> : null}
      />
      {extractsError ? <NoticeBanner>{extractsError}</NoticeBanner> : null}

      <Panel>
        <Toolbar>
          <ToolbarGroup>
            <span className="text-[13px] font-semibold">{messages.extracts.resultFiles}</span>
            <span className="text-xs text-text-tertiary">{messages.common.count(extracts.length)}</span>
          </ToolbarGroup>
          <span className="text-xs text-text-tertiary">
            {messages.extracts.refresh}
          </span>
        </Toolbar>
        <DataGrid
          headers={[...messages.extracts.headers]}
        >
          {extracts.length === 0 ? (
            <EmptyGridRow cols={7} text={messages.empty.extracts} />
          ) : (
            extracts.map((extract) => (
              <GridRow key={extract.id}>
                <GridCell mono>
                  {extract.sql_text ? (
                    <span title={extract.sql_text}>
                      {messages.extracts.querySource} · {fmtSqlPreview(extract.sql_text)}
                    </span>
                  ) : (
                    extract.table_name
                  )}
                </GridCell>
                <GridCell>
                  {extract.connection_name || extract.connection_id.slice(0, 8)}
                </GridCell>
                <GridCell mono muted>
                  {fmtDelimiter(extract.delimiter, messages)}
                </GridCell>
                <GridCell>
                  <StatusPill value={extract.status} />
                </GridCell>
                <GridCell mono>
                  {extract.status === "queued" || extract.status === "running"
                    ? extract.row_count != null
                      ? messages.extracts.writing(extract.row_count)
                      : extract.status === "running"
                        ? messages.common.running
                        : "—"
                    : extract.row_count ?? "—"}
                </GridCell>
                <GridCell mono muted>
                  {fmtWhen(extract.created_at)}
                </GridCell>
                <GridCell>
                  {extract.status === "succeeded" ? (
                    <ActionAnchor href={extractApi.getDownloadUrl(extract.id)}>
                      {messages.common.download}
                    </ActionAnchor>
                  ) : extract.error_message ? (
                    <span className="text-xs text-danger">{extract.error_message}</span>
                  ) : (
                    <span className="text-text-tertiary">—</span>
                  )}
                </GridCell>
              </GridRow>
            ))
          )}
        </DataGrid>
      </Panel>
    </PageShell>
  );
}
