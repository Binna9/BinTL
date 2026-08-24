import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CatalogTree } from "@/components/CatalogTree";
import { ConnectionInfoPanel } from "@/components/ConnectionInfoPanel";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { PageHeader, PageShell } from "@/components/PageShell";
import { SplitLayout } from "@/components/SplitLayout";
import { Button } from "@/components/ui/button";
import { NoticeBanner } from "@/components/ui/notice-banner";
import { PaneHeader } from "@/components/ui/pane-header";
import { Panel } from "@/components/ui/panel";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { useConnectionColumns } from "@/hooks/useConnectionColumns";
import { useConnections } from "@/hooks/useConnections";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { layout } from "@/lib/layout";
import { selectableClass } from "@/lib/selectable";
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
  const { messages } = useLanguage();
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
          ? messages.query.executed(outcome.row_count, outcome.elapsed_ms)
          : messages.query.result(outcome.row_count, outcome.truncated, outcome.elapsed_ms),
      );
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : messages.errors.query);
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
      setError(err instanceof Error ? err.message : messages.errors.extract);
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
        eyebrow={messages.query.eyebrow}
        title={messages.query.title}
        description={messages.query.description}
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
                <PaneHeader title={messages.common.connections} meta={messages.common.count(connections.length)} />
                <div className="min-h-0 flex-1 overflow-y-auto bg-surface">
                  {connections.length === 0 ? (
                    <p className="p-3 text-xs text-text-tertiary">{messages.empty.connections}</p>
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
                <PaneHeader title={messages.common.catalog} />
                <div className="min-h-0 flex-1 overflow-y-auto bg-surface">
                  {browseId ? (
                    <CatalogTree connectionId={browseId} selected={selected} onPick={setSelected} />
                  ) : (
                    <p className="p-3 text-xs text-text-tertiary">{messages.empty.query}</p>
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
                  <PaneHeader title={messages.common.columns} meta={`${connectionColumns.length}`} />
                  <div className="min-h-0 flex-1 overflow-y-auto bg-surface">
                    {connectionColumns.length === 0 ? (
                      <p className="p-3 text-xs text-text-tertiary">{messages.query.columnsHint}</p>
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
                                title={messages.query.insertHint}
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
                    description={messages.query.runHint}
                    actions={
                      <>
                        <Button
                          type="button"
                          variant="quiet"
                          disabled={!selected}
                          onClick={() => applyDraft(picked)}
                        >
                          {messages.query.draft}
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
                      {messages.query.preview}
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
                      {messages.common.delimiter}
                      <input
                        className="field-control technical w-16 text-center"
                        value={delimiter}
                        onChange={(event) => setDelimiter(event.target.value)}
                        placeholder=","
                        title={messages.connectionsPage.delimiterTitle}
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
                      {messages.common.header}
                    </label>
                  </ToolbarGroup>
                  <ToolbarGroup>
                    <Button type="button" variant="secondary" disabled={!canRun || running} onClick={() => void onRun()}>
                      {running ? messages.common.running : messages.common.run}
                    </Button>
                    <Button
                      type="button"
                      variant="primary"
                      disabled={!canExtract || extracting}
                      onClick={() => void onExtract()}
                    >
                      {extracting ? messages.connectionsPage.extracting : messages.query.resultFile}
                    </Button>
                  </ToolbarGroup>
                </Toolbar>

                <section className="min-h-0 flex-1 overflow-hidden">
                  {!result ? (
                    <div className="grid h-full place-items-center text-[13px] text-text-tertiary">
                      {messages.empty.query}
                    </div>
                  ) : result.columns.length === 0 ? (
                    <div className="grid h-full place-items-center text-[13px] text-text-tertiary">
                      {messages.empty.preview}
                    </div>
                  ) : (
                    <DataGrid className="h-full" headers={result.columns}>
                      {result.rows.length === 0 ? (
                        <EmptyGridRow cols={result.columns.length} text={messages.empty.preview} />
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
