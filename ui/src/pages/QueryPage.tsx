import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/Button";
import { CatalogTree } from "@/components/CatalogTree";
import { ConnectionInfoPanel } from "@/components/ConnectionInfoPanel";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { NoticeBanner } from "@/components/NoticeBanner";
import { PageHeader, PageShell } from "@/components/PageShell";
import { PaneHeader } from "@/components/PaneHeader";
import { Panel } from "@/components/Panel";
import { SplitLayout } from "@/components/SplitLayout";
import { Toolbar, ToolbarGroup } from "@/components/Toolbar";
import { useConnectionColumns } from "@/hooks/useConnectionColumns";
import { useConnections } from "@/hooks/useConnections";
import { cn } from "@/lib/cn";
import { layout } from "@/lib/layout";
import { selectableClass } from "@/lib/selectable";
import { emptyCopy } from "@/mock/emptyStates";
import { extractApi } from "@/services/extractApi";
import { queryApi } from "@/services/queryApi";
import type { CatalogSelection } from "@/types/connection";
import type { QueryResult } from "@/types/query";

function sqlStorageKey(id: string): string {
  return `bintl.query.sql.${id}`;
}

function draftSelect(table: string, columns: string[]): string {
  const list = columns.length ? columns.map((column) => `  ${column}`).join(",\n") : "  *";
  return `SELECT\n${list}\nFROM ${table}`;
}

export function QueryPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const { connections, connectionsError } = useConnections();
  const [browseId, setBrowseId] = useState(params.get("connection") ?? "");
  const [selected, setSelected] = useState<CatalogSelection | null>(null);
  const { connectionColumns, connectionColumnsError } = useConnectionColumns(
    browseId,
    selected,
  );
  const [picked, setPicked] = useState<string[]>([]);
  const [sql, setSql] = useState("");
  const [delimiter, setDelimiter] = useState(",");
  const [header, setHeader] = useState(true);
  const [limit, setLimit] = useState(100);
  const [running, setRunning] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const active = useMemo(
    () => connections.find((connection) => connection.id === browseId),
    [connections, browseId],
  );

  useEffect(() => {
    if (!browseId) {
      setSelected(null);
      setPicked([]);
      return;
    }
    const saved = localStorage.getItem(sqlStorageKey(browseId));
    if (saved && !sql) setSql(saved);
  }, [browseId]);

  useEffect(() => setPicked([]), [browseId, selected]);

  useEffect(() => {
    const table = params.get("table");
    const database = params.get("database");
    if (!browseId || !table || !database) return;
    if (localStorage.getItem(sqlStorageKey(browseId))) return;
    persistSql(draftSelect(table, []));
  }, [browseId]);

  function persistSql(next: string) {
    setSql(next);
    if (browseId) localStorage.setItem(sqlStorageKey(browseId), next);
  }

  function onPickConnection(id: string) {
    if (browseId === id) {
      if (sql) localStorage.setItem(sqlStorageKey(browseId), sql);
      setBrowseId("");
      setSelected(null);
      setPicked([]);
      setResult(null);
      return;
    }
    if (browseId && sql) localStorage.setItem(sqlStorageKey(browseId), sql);
    setBrowseId(id);
    setSelected(null);
    setPicked([]);
    setResult(null);
    setError("");
    const saved = localStorage.getItem(sqlStorageKey(id));
    setSql(saved ?? "");
  }

  function insertAtCursor(text: string) {
    const el = editorRef.current;
    if (!el) {
      persistSql(sql + text);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = `${sql.slice(0, start)}${text}${sql.slice(end)}`;
    persistSql(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
    });
  }

  function applyDraft(columnsToUse: string[]) {
    if (!selected) return;
    persistSql(draftSelect(selected.qualified, columnsToUse));
  }

  function toggleColumn(name: string) {
    setPicked((current) =>
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name],
    );
  }

  async function onRun() {
    if (!browseId) return;
    setRunning(true);
    setError("");
    setInfo("");
    try {
      const outcome = await queryApi.runQuery(browseId, sql, limit, selected?.database);
      setResult(outcome);
      setInfo(
        outcome.kind === "exec"
          ? `실행됨 · 영향 행 ${outcome.row_count} · ${outcome.elapsed_ms}ms`
          : `${outcome.row_count}행${outcome.truncated ? " (미리보기 제한)" : ""} · ${outcome.elapsed_ms}ms`,
      );
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : "쿼리 실행에 실패했습니다");
    } finally {
      setRunning(false);
    }
  }

  async function onExtract() {
    if (!browseId) return;
    setExtracting(true);
    setError("");
    try {
      await extractApi.createExtract({
        connection_id: browseId,
        table: selected?.qualified || "query",
        database: selected?.database,
        sql,
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

  function onEditorKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Tab") {
      event.preventDefault();
      insertAtCursor("  ");
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void onRun();
    }
  }

  const canRun = Boolean(browseId && sql.trim());
  const canExtract = canRun && result?.kind !== "exec";

  return (
    <PageShell>
      <PageHeader
        iconName="query"
        eyebrow="작업 공간"
        title="DB"
        description="커넥션과 스키마를 옆에 두고 SQL을 실행한 뒤, 결과 전체를 서버 파일로 받습니다. 각 실행은 새 연결입니다."
      />
      {info ? <NoticeBanner tone="ok">{info}</NoticeBanner> : null}
      {error || connectionsError || connectionColumnsError ? (
        <NoticeBanner>
          {error || connectionsError || connectionColumnsError}
        </NoticeBanner>
      ) : null}

      <Panel className="overflow-hidden">
        <SplitLayout
          className="h-[calc(100vh-12.5rem)] min-h-[32rem]"
          defaultSizes={[layout.split.sidebar]}
        >
          <aside className="flex h-full min-h-0 flex-col overflow-hidden">
            <SplitLayout
              className="h-full"
              direction="vertical"
              defaultSizes={[layout.split.connections]}
              minSize={layout.split.minStack}
            >
              <div className="flex h-full min-h-0 flex-col">
                <PaneHeader title="커넥션" meta={`${connections.length}개`} />
                <div className="min-h-0 flex-1 overflow-y-auto bg-surface">
                  {connections.length === 0 ? (
                    <p className="p-3 text-xs text-text-tertiary">{emptyCopy.connections}</p>
                  ) : (
                    connections.map((connection) => (
                      <button
                        key={connection.id}
                        type="button"
                        title={connection.name}
                        className={cn(
                          "block w-full min-w-0 overflow-hidden border-b border-border px-3 py-2 text-left last:border-b-0",
                          selectableClass(connection.id === browseId),
                        )}
                        onClick={() => onPickConnection(connection.id)}
                      >
                        <span className="block truncate text-[13px] text-text">{connection.name}</span>
                        <span className="mt-0.5 block truncate text-[11px] text-text-tertiary">
                          {connection.driver} · {connection.database_name}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
              <div className="flex h-full min-h-0 flex-col">
                <PaneHeader title="카탈로그" />
                <div className="min-h-0 flex-1 overflow-y-auto bg-surface">
                  {browseId ? (
                    <CatalogTree connectionId={browseId} selected={selected} onPick={setSelected} />
                  ) : (
                    <p className="p-3 text-xs text-text-tertiary">{emptyCopy.query}</p>
                  )}
                </div>
              </div>
            </SplitLayout>
          </aside>

          <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
            <ConnectionInfoPanel
              connection={active}
              selectedTable={selected?.qualified}
            />

            <SplitLayout
              className="min-h-0 flex-1"
              direction="vertical"
              defaultSizes={[layout.split.editor]}
            >
              <SplitLayout className="min-h-0" defaultSizes={[layout.split.columns]}>
                <section className="flex h-full min-h-0 flex-col overflow-hidden">
                  <PaneHeader title="컬럼" meta={`${connectionColumns.length}`} />
                  <div className="min-h-0 flex-1 overflow-y-auto bg-surface">
                    {connectionColumns.length === 0 ? (
                      <p className="p-3 text-xs text-text-tertiary">테이블을 선택하면 컬럼이 표시됩니다.</p>
                    ) : (
                      <ul className="m-0 list-none p-0">
                        {connectionColumns.map((column) => (
                          <li key={column.name} className="border-b border-border last:border-b-0">
                            <label
                              className={cn(
                                "flex cursor-pointer items-start gap-2 overflow-hidden px-3 py-1.5",
                                selectableClass(picked.includes(column.name)),
                              )}
                            >
                              <input
                                className="field-control mt-0.5"
                                type="checkbox"
                                checked={picked.includes(column.name)}
                                onChange={() => toggleColumn(column.name)}
                              />
                              <button
                                type="button"
                                className="min-w-0 flex-1 overflow-hidden text-left"
                                onDoubleClick={() => insertAtCursor(column.name)}
                                title="더블클릭하면 편집기에 넣습니다"
                              >
                                <span className="block truncate text-xs">{column.name}</span>
                                <span className="block truncate text-[11px] text-text-tertiary">
                                  {column.data_type}
                                  {column.nullable ? "" : " · NOT NULL"}
                                </span>
                              </button>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </section>
                <section className="flex h-full min-h-0 flex-col">
                  <PaneHeader
                    title="SQL"
                    description="Ctrl+Enter 실행"
                    actions={
                      <>
                        <Button
                          type="button"
                          variant="quiet"
                          disabled={!selected}
                          onClick={() => applyDraft(picked)}
                        >
                          선택 컬럼으로 초안
                        </Button>
                        <Button
                          type="button"
                          variant="quiet"
                          disabled={!selected}
                          onClick={() => applyDraft([])}
                        >
                          SELECT *
                        </Button>
                      </>
                    }
                  />
                  <textarea
                    ref={editorRef}
                    className="sql-editor flex-1"
                    spellCheck={false}
                    value={sql}
                    onChange={(event) => persistSql(event.target.value)}
                    onKeyDown={onEditorKey}
                    placeholder={"SELECT id, name\nFROM public.users\nWHERE active = true"}
                    disabled={!browseId}
                  />
                </section>
              </SplitLayout>

              <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
                <Toolbar>
                  <ToolbarGroup>
                    <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                      미리보기
                      <input
                        className="field-control technical w-16 text-center"
                        type="number"
                        min={1}
                        max={500}
                        value={limit}
                        onChange={(event) => setLimit(Number(event.target.value) || 100)}
                      />
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                      구분자
                      <input
                        className="field-control technical w-16 text-center"
                        value={delimiter}
                        onChange={(event) => setDelimiter(event.target.value)}
                        placeholder=","
                        title="ASCII 한 글자. 탭은 tab"
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
                  </ToolbarGroup>
                  <ToolbarGroup>
                    <Button type="button" variant="secondary" disabled={!canRun || running} onClick={() => void onRun()}>
                      {running ? "실행 중…" : "실행"}
                    </Button>
                    <Button
                      type="button"
                      variant="primary"
                      disabled={!canExtract || extracting}
                      onClick={() => void onExtract()}
                    >
                      {extracting ? "추출 중…" : "결과 파일로 받기"}
                    </Button>
                  </ToolbarGroup>
                </Toolbar>

                <section className="min-h-0 flex-1 overflow-hidden">
                  {!result ? (
                    <div className="grid h-full place-items-center text-[13px] text-text-tertiary">
                      {emptyCopy.query}
                    </div>
                  ) : result.columns.length === 0 ? (
                    <div className="grid h-full place-items-center text-[13px] text-text-tertiary">
                      {emptyCopy.preview}
                    </div>
                  ) : (
                    <DataGrid className="h-full" headers={result.columns}>
                      {result.rows.length === 0 ? (
                        <EmptyGridRow cols={result.columns.length} text={emptyCopy.preview} />
                      ) : (
                        result.rows.map((row, rowIndex) => (
                          <GridRow key={rowIndex}>
                            {row.map((cell, cellIndex) => (
                              <GridCell key={cellIndex} mono>
                                {cell}
                              </GridCell>
                            ))}
                          </GridRow>
                        ))
                      )}
                    </DataGrid>
                  )}
                </section>
              </div>
            </SplitLayout>
          </div>
        </SplitLayout>
      </Panel>
    </PageShell>
  );
}
