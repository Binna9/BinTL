import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/Button";
import { CatalogTree } from "@/components/CatalogTree";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { FormField } from "@/components/FormField";
import { NoticeBanner } from "@/components/NoticeBanner";
import { PageHeader, PageShell } from "@/components/PageShell";
import { PaneHeader } from "@/components/PaneHeader";
import { Panel, PanelBody, PanelHeader } from "@/components/Panel";
import { SplitLayout } from "@/components/SplitLayout";
import { Toolbar, ToolbarGroup } from "@/components/Toolbar";
import { useConnections } from "@/hooks/useConnections";
import { cn } from "@/lib/cn";
import { layout } from "@/lib/layout";
import { selectableClass } from "@/lib/selectable";
import { driverCatalog } from "@/mock/driverCatalog";
import { emptyCopy } from "@/mock/emptyStates";
import { connectionApi } from "@/services/connectionApi";
import { extractApi } from "@/services/extractApi";
import type {
  CatalogSelection,
  DatabaseColumn,
  TablePreview,
} from "@/types/connection";

export function ConnectionsPage() {
  const navigate = useNavigate();
  const {
    connections,
    connectionsError,
    setConnectionsError,
    refreshConnections,
  } = useConnections();
  const [info, setInfo] = useState("");
  const [saving, setSaving] = useState(false);
  const [browseId, setBrowseId] = useState("");
  const [selected, setSelected] = useState<CatalogSelection | null>(null);
  const [columns, setColumns] = useState<DatabaseColumn[]>([]);
  const [preview, setPreview] = useState<TablePreview | null>(null);
  const [delimiter, setDelimiter] = useState(",");
  const [header, setHeader] = useState(true);
  const [extracting, setExtracting] = useState(false);

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const field = (name: string) =>
      form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
    const port = field("port").value;

    setSaving(true);
    setConnectionsError("");
    setInfo("");
    try {
      await connectionApi.createConnection({
        name: field("name").value,
        driver: field("driver").value,
        host: field("host").value,
        port: port ? Number(port) : undefined,
        database: field("database").value,
        username: field("username").value,
        password: field("password").value,
        ssl: (field("ssl") as HTMLInputElement).checked,
      });
      form.reset();
      await refreshConnections();
      setInfo("커넥션을 etl.db에 저장했습니다");
    } catch (err) {
      setConnectionsError(err instanceof Error ? err.message : "커넥션 저장에 실패했습니다");
    } finally {
      setSaving(false);
    }
  }

  async function onTest(id: string) {
    setConnectionsError("");
    setInfo("");
    try {
      await connectionApi.testConnection(id);
      setInfo("연결 테스트에 성공했습니다");
    } catch (err) {
      setConnectionsError(err instanceof Error ? err.message : "연결 테스트에 실패했습니다");
    }
  }

  async function onBrowse(id: string) {
    if (browseId === id) {
      setBrowseId("");
      setSelected(null);
      setColumns([]);
      setPreview(null);
      return;
    }
    setBrowseId(id);
    setSelected(null);
    setColumns([]);
    setPreview(null);
    setConnectionsError("");
  }

  async function onSelectTable(pick: CatalogSelection | null) {
    if (!pick) {
      setSelected(null);
      setColumns([]);
      setPreview(null);
      return;
    }
    if (!browseId) return;
    setSelected(pick);
    setConnectionsError("");
    try {
      const [columnResult, previewResult] = await Promise.all([
        connectionApi.getColumns(browseId, pick.qualified, pick.database),
        connectionApi.getPreview(browseId, pick.qualified, 50, pick.database),
      ]);
      setColumns(columnResult.columns);
      setPreview(previewResult);
    } catch (err) {
      setColumns([]);
      setPreview(null);
      setConnectionsError(
        err instanceof Error ? err.message : "테이블 정보를 조회하지 못했습니다",
      );
    }
  }

  async function onExtract(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!browseId || !selected) return;
    setExtracting(true);
    setConnectionsError("");
    try {
      await extractApi.createExtract({
        connection_id: browseId,
        table: selected.qualified,
        database: selected.database,
        delimiter,
        header,
      });
      navigate("/extracts");
    } catch (err) {
      setConnectionsError(err instanceof Error ? err.message : "파일 추출에 실패했습니다");
    } finally {
      setExtracting(false);
    }
  }

  async function onDelete(id: string) {
    setConnectionsError("");
    try {
      await connectionApi.deleteConnection(id);
      if (browseId === id) {
        setBrowseId("");
        setSelected(null);
        setColumns([]);
        setPreview(null);
      }
      await refreshConnections();
    } catch (err) {
      setConnectionsError(err instanceof Error ? err.message : "커넥션 삭제에 실패했습니다");
    }
  }

  const activeConnection = connections.find((connection) => connection.id === browseId);

  return (
    <PageShell>
      <PageHeader
        iconName="connections"
        eyebrow="소스"
        title="커넥션"
        description="데이터베이스 연결을 등록하고 스키마를 조회합니다. 테이블 전체 추출 또는 쿼리 편집기로 이어서 작업할 수 있습니다."
      />
      {info ? <NoticeBanner tone="ok">{info}</NoticeBanner> : null}
      {connectionsError ? <NoticeBanner>{connectionsError}</NoticeBanner> : null}

      <Panel>
        <PanelHeader title="새 커넥션" description="접속 정보는 암호화되어 로컬 메타데이터 저장소에 보관됩니다." />
        <PanelBody>
          <form className="grid grid-cols-4 items-end gap-3" onSubmit={(event) => void onSave(event)}>
            <FormField label="이름">
              <input className="field-control" name="name" required />
            </FormField>
            <FormField label="드라이버">
              <select className="field-control" name="driver">
                {driverCatalog.map((driver) => (
                  <option key={driver.value} value={driver.value}>{driver.label}</option>
                ))}
              </select>
            </FormField>
            <FormField label="호스트">
              <input className="field-control" name="host" defaultValue="127.0.0.1" required />
            </FormField>
            <FormField label="포트">
              <input className="field-control technical" name="port" placeholder="5432" />
            </FormField>
            <FormField label="데이터베이스">
              <input className="field-control" name="database" required placeholder="dbname 또는 /path/to.db" />
            </FormField>
            <FormField label="사용자 이름">
              <input className="field-control" name="username" required />
            </FormField>
            <FormField label="비밀번호">
              <input className="field-control" name="password" type="password" />
            </FormField>
            <div className="flex h-8 items-center justify-between gap-3">
              <label className="flex min-w-0 items-center gap-2 text-xs text-text-secondary">
                <input className="field-control" name="ssl" type="checkbox" />
                SSL 사용
                <span className="truncate text-[11px] font-normal text-text-tertiary">
                  데이터베이스와의 연결을 암호화합니다
                </span>
              </label>
              <Button variant="primary" type="submit" disabled={saving}>
                {saving ? "저장 중…" : "저장"}
              </Button>
            </div>
          </form>
        </PanelBody>
      </Panel>

      <Panel className="min-h-[34rem]">
        <Toolbar>
          <ToolbarGroup>
            <span className="text-[13px] font-semibold">데이터 탐색기</span>
            <span className="text-xs text-text-tertiary">
              {activeConnection ? activeConnection.name : "커넥션을 선택하세요"}
            </span>
          </ToolbarGroup>
        </Toolbar>

        <SplitLayout className="min-h-[31rem]" defaultSizes={[layout.split.sidebar]}>
          <aside className="flex h-full min-h-0 flex-col">
            <PaneHeader title="커넥션" meta={`${connections.length}개`} />
            <div className="min-h-0 flex-1 overflow-y-auto bg-surface">
              {connections.length === 0 ? (
                <p className="p-4 text-xs text-text-tertiary">{emptyCopy.connections}</p>
              ) : (
                <ul className="m-0 list-none p-0">
                  {connections.map((connection) => (
                    <li
                      key={connection.id}
                      className={cn(
                        "border-b border-border p-3",
                        selectableClass(connection.id === browseId),
                      )}
                    >
                      <button
                        type="button"
                        title={connection.name}
                        className="block w-full min-w-0 overflow-hidden text-left"
                        onClick={() => void onBrowse(connection.id)}
                      >
                        <span className="block truncate text-[13px] text-text">{connection.name}</span>
                        <span className="mt-1 block truncate text-[11px] text-text-tertiary">
                          {connection.driver} · {connection.host}:{connection.port}
                        </span>
                      </button>
                      <div className="mt-2 flex gap-1">
                        <Button type="button" variant="quiet" onClick={() => void onTest(connection.id)}>
                          테스트
                        </Button>
                        <Button
                          type="button"
                          variant="quiet"
                          onClick={() => navigate(`/db?connection=${connection.id}`)}
                        >
                          쿼리
                        </Button>
                        <Button type="button" variant="danger" onClick={() => void onDelete(connection.id)}>
                          삭제
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>

          {!activeConnection ? (
            <div className="grid h-full place-items-center text-[13px] text-text-tertiary">
              왼쪽에서 커넥션을 선택해 데이터 구조를 조회하세요.
            </div>
          ) : (
            <SplitLayout className="h-full min-w-0" defaultSizes={[layout.split.catalog]}>
              <aside className="flex h-full min-h-0 flex-col bg-surface">
                <PaneHeader title="카탈로그" />
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <CatalogTree
                    connectionId={activeConnection.id}
                    selected={selected}
                    onPick={(pick) => void onSelectTable(pick)}
                  />
                </div>
              </aside>

              {!selected ? (
                <div className="grid h-full place-items-center text-[13px] text-text-tertiary">
                  데이터베이스를 연 뒤 테이블을 선택하면 컬럼과 샘플 데이터를 표시합니다.
                </div>
              ) : (
                <div className="flex h-full min-w-0 flex-col">
                  <Toolbar>
                    <ToolbarGroup>
                      <span className="technical font-semibold text-text">{selected.qualified}</span>
                    </ToolbarGroup>
                    <form className="flex items-center gap-2" onSubmit={(event) => void onExtract(event)}>
                      <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                        구분자
                        <input
                          className="field-control technical w-16 text-center"
                          value={delimiter}
                          onChange={(event) => setDelimiter(event.target.value)}
                          placeholder=","
                          title="ASCII 한 글자. 탭은 tab"
                          aria-label="구분자"
                          required
                        />
                      </label>
                      <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                        <input
                          className="field-control"
                          type="checkbox"
                          checked={header}
                          onChange={(event) => setHeader(event.target.checked)}
                        />
                        헤더
                      </label>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() =>
                          navigate(
                            `/db?connection=${browseId}&table=${encodeURIComponent(selected.qualified)}&database=${encodeURIComponent(selected.database)}`,
                          )
                        }
                      >
                        DB 편집
                      </Button>
                      <Button variant="primary" type="submit" disabled={extracting}>
                        {extracting ? "추출 중…" : "파일로 추출"}
                      </Button>
                    </form>
                  </Toolbar>

                  <SplitLayout className="min-h-0 flex-1" defaultSizes={[layout.split.columns]}>
                    <section className="flex h-full min-h-0 flex-col overflow-hidden">
                      <PaneHeader title="컬럼" meta={`${columns.length}`} />
                      <div className="min-h-0 flex-1 overflow-auto bg-surface">
                        <DataGrid headers={["이름", "타입", "NULL"]}>
                          {columns.map((column) => (
                            <GridRow key={column.name}>
                              <GridCell mono>{column.name}</GridCell>
                              <GridCell mono muted>{column.data_type}</GridCell>
                              <GridCell muted>{column.nullable ? "예" : "아니오"}</GridCell>
                            </GridRow>
                          ))}
                        </DataGrid>
                      </div>
                    </section>
                    <section className="flex h-full min-h-0 flex-col overflow-hidden">
                      <PaneHeader title="데이터 미리보기" />
                      <div className="min-h-0 flex-1 overflow-auto bg-surface">
                        {preview ? (
                          <DataGrid className="h-full" headers={preview.columns}>
                            {preview.rows.length === 0 ? (
                              <EmptyGridRow cols={preview.columns.length || 1} text={emptyCopy.preview} />
                            ) : (
                              preview.rows.map((row, rowIndex) => (
                                <GridRow key={rowIndex}>
                                  {row.map((cell, cellIndex) => (
                                    <GridCell key={cellIndex} mono>{cell}</GridCell>
                                  ))}
                                </GridRow>
                              ))
                            )}
                          </DataGrid>
                        ) : null}
                      </div>
                    </section>
                  </SplitLayout>
                </div>
              )}
            </SplitLayout>
          )}
        </SplitLayout>
      </Panel>
    </PageShell>
  );
}
