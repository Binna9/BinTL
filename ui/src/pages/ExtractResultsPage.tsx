import { ActionAnchor } from "@/components/Button";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { LiveDot } from "@/components/LiveDot";
import { NoticeBanner } from "@/components/NoticeBanner";
import { PageHeader, PageShell } from "@/components/PageShell";
import { Panel } from "@/components/Panel";
import { StatusPill } from "@/components/StatusPill";
import { Toolbar, ToolbarGroup } from "@/components/Toolbar";
import { isExtractActive, useExtracts } from "@/hooks/useExtracts";
import { fmtDelimiter, fmtSqlPreview, fmtWhen } from "@/lib/format";
import { emptyCopy } from "@/mock/emptyStates";
import { extractApi } from "@/services/extractApi";

export function ExtractResultsPage() {
  const { extracts, extractsError } = useExtracts();
  const activeCount = extracts.filter((extract) => isExtractActive(extract.status)).length;

  return (
    <PageShell>
      <PageHeader
        iconName="extracts"
        eyebrow="추출"
        title="추출 결과"
        description="데이터베이스와 쿼리에서 생성한 결과 파일의 진행 상태와 다운로드를 관리합니다."
        actions={activeCount > 0 ? <LiveDot label={`${activeCount}개 생성 중`} /> : null}
      />
      {extractsError ? <NoticeBanner>{extractsError}</NoticeBanner> : null}

      <Panel className="min-h-0 flex-1">
        <Toolbar>
          <ToolbarGroup>
            <span className="text-[13px] font-semibold">결과 파일</span>
            <span className="text-xs text-text-tertiary">{extracts.length}개</span>
          </ToolbarGroup>
          <span className="text-xs text-text-tertiary">
            진행 중인 결과는 2초마다 갱신됩니다
          </span>
        </Toolbar>
        <DataGrid
          headers={["추출 소스", "커넥션", "형식", "상태", "행 수", "생성 시각", "결과"]}
        >
          {extracts.length === 0 ? (
            <EmptyGridRow cols={7} text={emptyCopy.extracts} />
          ) : (
            extracts.map((extract) => (
              <GridRow key={extract.id}>
                <GridCell mono>
                  {extract.sql_text ? (
                    <span title={extract.sql_text}>
                      쿼리 · {fmtSqlPreview(extract.sql_text)}
                    </span>
                  ) : (
                    extract.table_name
                  )}
                </GridCell>
                <GridCell>
                  {extract.connection_name || extract.connection_id.slice(0, 8)}
                </GridCell>
                <GridCell mono muted>
                  {fmtDelimiter(extract.delimiter)}
                </GridCell>
                <GridCell>
                  <StatusPill value={extract.status} />
                </GridCell>
                <GridCell mono>{extract.row_count ?? "—"}</GridCell>
                <GridCell mono muted>
                  {fmtWhen(extract.created_at)}
                </GridCell>
                <GridCell>
                  {extract.status === "succeeded" ? (
                    <ActionAnchor href={extractApi.getDownloadUrl(extract.id)}>
                      다운로드
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
