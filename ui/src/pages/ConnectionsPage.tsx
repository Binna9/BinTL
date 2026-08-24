import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/Button";
import { CatalogTree } from "@/components/CatalogTree";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { FormField } from "@/components/FormField";
import { NoticeBanner } from "@/components/NoticeBanner";
import { PageHeader, PageShell } from "@/components/PageShell";
import { Panel, PanelBody, PanelHeader } from "@/components/Panel";
import { Toolbar, ToolbarGroup } from "@/components/Toolbar";
import { api } from "@/lib/api";
import { driverCatalog } from "@/mock/driverCatalog";
import { emptyCopy } from "@/mock/emptyStates";
import type { CatalogPick, ColumnInfo, Connection, TablePreview } from "@/types/pipeline";

export function ConnectionsPage() {
  const navigate = useNavigate();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [saving, setSaving] = useState(false);
  const [browseId, setBrowseId] = useState("");
  const [selected, setSelected] = useState<CatalogPick | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [preview, setPreview] = useState<TablePreview | null>(null);
  const [delimiter, setDelimiter] = useState(",");
  const [header, setHeader] = useState(true);
  const [extracting, setExtracting] = useState(false);

  async function refresh() {
    const response = await api.connections();
    setConnections(response.connections);
  }

  useEffect(() => {
    void refresh().catch((err) =>
      setError(err instanceof Error ? err.message : "커넥션 목록을 불러오지 못했습니다"),
    );
  }, []);

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const field = (name: string) =>
      form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
    const port = field("port").value;

    setSaving(true);
    setError("");
    setInfo("");
    try {
      await api.createConnection({
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
      await refresh();
      setInfo("커넥션을 etl.db에 저장했습니다");
    } catch (err) {
      setError(err instanceof Error ? err.message : "커넥션 저장에 실패했습니다");
    } finally {
      setSaving(false);
    }
  }

  async function onTest(id: string) {
    setError("");
    setInfo("");
    try {
      await api.testConnection(id);
      setInfo("연결 테스트에 성공했습니다");
    } catch (err) {
      setError(err instanceof Error ? err.message : "연결 테스트에 실패했습니다");
    }
  }

  async function onBrowse(id: string) {
    setBrowseId(id);
    setSelected(null);
    setColumns([]);
    setPreview(null);
    setError("");
  }

  async function onSelectTable(pick: CatalogPick) {
    if (!browseId) return;
    setSelected(pick);
    setError("");
    try {
      const [columnResult, previewResult] = await Promise.all([
        api.connectionColumns(browseId, pick.qualified, pick.database),
        api.connectionPreview(browseId, pick.qualified, 50, pick.database),
      ]);
      setColumns(columnResult.columns);
      setPreview(previewResult);
    } catch (err) {
      setColumns([]);
      setPreview(null);
      setError(err instanceof Error ? err.message : "테이블 정보를 조회하지 못했습니다");
    }
  }

  async function onExtract(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!browseId || !selected) return;
    setExtracting(true);
    setError("");
    try {
      await api.createExtract({
        connection_id: browseId,
        table: selected.qualified,
        database: selected.database,
        delimiter,
        header,
      });
      navigate("/extracts");
    } catch (err) {
      setError(err instanceof Error ? err.message : "파일 추출에 실패했습니다");
    } finally {
      setExtracting(false);
    }
  }

  async function onDelete(id: string) {
    setError("");
    try {
      await api.deleteConnection(id);
      if (browseId === id) {
        setBrowseId("");
        setSelected(null);
        setColumns([]);
        setPreview(null);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "커넥션 삭제에 실패했습니다");
    }
  }

  const activeConnection = connections.find((connection) => connection.id === browseId);

  return (
    <PageShell>
      <PageHeader
        eyebrow="소스"
        title="커넥션"
        description="데이터베이스 연결을 등록하고 스키마를 조회합니다. 테이블 전체 추출 또는 쿼리 편집기로 이어서 작업할 수 있습니다."
      />
      {info ? <NoticeBanner tone="ok">{info}</NoticeBanner> : null}
      {error ? <NoticeBanner>{error}</NoticeBanner> : null}

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
              <label className="flex items-center gap-2 text-xs text-text-secondary">
                <input className="field-control" name="ssl" type="checkbox" />
                SSL 사용
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

        <div className="grid min-h-[31rem] grid-cols-[17rem_minmax(0,1fr)]">
          <aside className="border-r border-border">
            <div className="border-b border-border px-3 py-2 text-[11px] font-semibold text-text-secondary">
              저장된 커넥션 · {connections.length}
            </div>
            {connections.length === 0 ? (
              <p className="p-4 text-xs text-text-tertiary">{emptyCopy.connections}</p>
            ) : (
              <ul className="m-0 list-none p-0">
                {connections.map((connection) => (
                  <li
                    key={connection.id}
                    className={`border-b border-border p-3 ${
                      connection.id === browseId ? "bg-accent-subtle" : "hover:bg-subtle"
                    }`}
                  >
                    <button
                      type="button"
                      className="block w-full text-left"
                      onClick={() => void onBrowse(connection.id)}
                    >
                      <span className="block text-[13px] font-medium">{connection.name}</span>
                      <span className="mt-1 block text-[11px] text-text-tertiary">
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
                        onClick={() => navigate(`/query?connection=${connection.id}`)}
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
          </aside>

          {!activeConnection ? (
            <div className="grid place-items-center text-[13px] text-text-tertiary">
              왼쪽에서 커넥션을 선택해 데이터 구조를 조회하세요.
            </div>
          ) : (
            <div className="grid min-w-0 grid-cols-[16rem_minmax(0,1fr)]">
              <aside className="flex min-h-0 flex-col border-r border-border bg-raised">
                <div className="shrink-0 border-b border-border px-3 py-2">
                  <div className="text-[11px] font-semibold text-text-secondary">카탈로그</div>
                  <div className="mt-0.5 text-[11px] text-text-tertiary">
                    데이터베이스 → 스키마 → 테이블
                  </div>
                </div>
                <div className="max-h-[31rem] min-h-0 flex-1 overflow-y-auto">
                  <CatalogTree
                    connectionId={activeConnection.id}
                    selected={selected}
                    onPick={(pick) => void onSelectTable(pick)}
                  />
                </div>
              </aside>

              {!selected ? (
                <div className="grid place-items-center text-[13px] text-text-tertiary">
                  데이터베이스를 연 뒤 테이블을 선택하면 컬럼과 샘플 데이터를 표시합니다.
                </div>
              ) : (
                <div className="min-w-0">
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
                            `/query?connection=${browseId}&table=${encodeURIComponent(selected.qualified)}&database=${encodeURIComponent(selected.database)}`,
                          )
                        }
                      >
                        쿼리 편집
                      </Button>
                      <Button variant="primary" type="submit" disabled={extracting}>
                        {extracting ? "추출 중…" : "파일로 추출"}
                      </Button>
                    </form>
                  </Toolbar>

                  <div className="grid grid-cols-[16rem_minmax(0,1fr)]">
                    <section className="border-r border-border">
                      <div className="border-b border-border px-3 py-2 text-[11px] font-semibold text-text-secondary">
                        컬럼 · {columns.length}
                      </div>
                      <DataGrid headers={["이름", "타입", "NULL"]}>
                        {columns.map((column) => (
                          <GridRow key={column.name}>
                            <GridCell mono>{column.name}</GridCell>
                            <GridCell mono muted>{column.data_type}</GridCell>
                            <GridCell muted>{column.nullable ? "예" : "아니오"}</GridCell>
                          </GridRow>
                        ))}
                      </DataGrid>
                    </section>
                    <section className="min-w-0">
                      <div className="border-b border-border px-3 py-2 text-[11px] font-semibold text-text-secondary">
                        데이터 미리보기
                      </div>
                      {preview ? (
                        <DataGrid className="max-h-[27rem]" headers={preview.columns}>
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
                    </section>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </Panel>
    </PageShell>
  );
}
