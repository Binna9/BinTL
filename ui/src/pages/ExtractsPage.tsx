import { useEffect, useState } from "react";
import { ActionAnchor } from "@/components/Button";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { LiveDot } from "@/components/LiveDot";
import { NoticeBanner } from "@/components/NoticeBanner";
import { PageHeader, PageShell } from "@/components/PageShell";
import { Panel } from "@/components/Panel";
import { StatusPill } from "@/components/StatusPill";
import { Toolbar, ToolbarGroup } from "@/components/Toolbar";
import { api, extractFileUrl } from "@/lib/api";
import { fmtDelimiter, fmtSqlPreview, fmtWhen } from "@/lib/format";
import { emptyCopy } from "@/mock/emptyStates";
import type { ExtractItem } from "@/types/pipeline";

function isActive(status: string): boolean {
  return status === "queued" || status === "running";
}

export function ExtractsPage() {
  const [items, setItems] = useState<ExtractItem[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let timer: number | undefined;
    let cancelled = false;

    async function refresh() {
      try {
        const response = await api.extracts();
        if (cancelled) return;
        setItems(response.extracts);
        setError("");
        if (response.extracts.some((extract) => isActive(extract.status))) {
          timer = window.setTimeout(() => void refresh(), 2000);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "추출 목록을 불러오지 못했습니다");
        }
      }
    }

    void refresh();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  const activeCount = items.filter((item) => isActive(item.status)).length;

  return (
    <PageShell>
      <PageHeader
        iconName="extracts"
        eyebrow="작업 공간"
        title="추출"
        description="테이블 전체 또는 쿼리 결과로 만든 서버 파일과 처리 상태입니다."
        actions={activeCount > 0 ? <LiveDot label={`${activeCount}개 기록 중`} /> : null}
      />
      {error ? <NoticeBanner>{error}</NoticeBanner> : null}

      <Panel className="min-h-0 flex-1">
        <Toolbar>
          <ToolbarGroup>
            <span className="text-[13px] font-semibold">추출 파일</span>
            <span className="text-xs text-text-tertiary">{items.length}개</span>
          </ToolbarGroup>
          <span className="text-xs text-text-tertiary">활성 작업은 2초마다 갱신됩니다</span>
        </Toolbar>
        <DataGrid headers={["소스", "커넥션", "형식", "상태", "행 수", "생성 시각", "작업"]}>
          {items.length === 0 ? (
            <EmptyGridRow cols={7} text={emptyCopy.extracts} />
          ) : (
            items.map((extract) => (
              <GridRow key={extract.id}>
                <GridCell mono>
                  {extract.sql_text ? (
                    <span title={extract.sql_text}>쿼리 · {fmtSqlPreview(extract.sql_text)}</span>
                  ) : (
                    extract.table_name
                  )}
                </GridCell>
                <GridCell>{extract.connection_name || extract.connection_id.slice(0, 8)}</GridCell>
                <GridCell mono muted>
                  {fmtDelimiter(extract.delimiter)}
                </GridCell>
                <GridCell>
                  <StatusPill value={extract.status} />
                </GridCell>
                <GridCell mono>{extract.row_count ?? "—"}</GridCell>
                <GridCell mono muted>{fmtWhen(extract.created_at)}</GridCell>
                <GridCell>
                  {extract.status === "succeeded" ? (
                    <ActionAnchor href={extractFileUrl(extract.id)}>다운로드</ActionAnchor>
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
