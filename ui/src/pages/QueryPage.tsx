import {
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Play, X } from "lucide-react";
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
  const [isResultOpen, setIsResultOpen] = useState(false);
  const [dialogOffset, setDialogOffset] = useState({ x: 0, y: 0 });
  const dialogDrag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

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

  useEffect(() => {
    if (!isResultOpen) return;
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setIsResultOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isResultOpen]);

  useEffect(() => {
    function onMouseMove(event: MouseEvent) {
      const drag = dialogDrag.current;
      if (!drag) return;
      setDialogOffset({
        x: drag.left + event.clientX - drag.x,
        y: drag.top + event.clientY - drag.y,
      });
    }
    function onMouseUp() {
      dialogDrag.current = null;
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

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

  function onPickTable(next: CatalogSelection | null) {
    setSelected(next);
    setPicked([]);
    setSql("");
    setResult(null);
    setInfo("");
    setError("");
    setIsResultOpen(false);
    if (browseId) localStorage.removeItem(sqlStorageKey(browseId));
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
    if (!browseId || !sql.trim()) return;
    setDialogOffset({ x: 0, y: 0 });
    setIsResultOpen(true);
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

  function onDialogHeaderDown(event: ReactMouseEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("button")) return;
    dialogDrag.current = {
      x: event.clientX,
      y: event.clientY,
      left: dialogOffset.x,
      top: dialogOffset.y,
    };
    document.body.style.userSelect = "none";
  }

  return (
    <PageShell>
      <PageHeader
        iconName="query"
        eyebrow={messages.query.eyebrow}
        title={messages.query.title}
        description={messages.query.description}
      />
      {connectionsError || connectionColumnsError ? (
        <NoticeBanner>
          {connectionsError || connectionColumnsError}
        </NoticeBanner>
      ) : null}

      <Panel className="overflow-hidden">
        <SplitLayout
          className="h-[calc(100vh-12.5rem)] min-h-0"
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
                    <CatalogTree
                      connectionId={browseId}
                      selected={selected}
                      onPick={onPickTable}
                    />
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

            <SplitLayout className="min-h-0 flex-1" defaultSizes={[layout.split.columns]}>
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

              <section className="flex h-full min-h-0 flex-col bg-raised p-3">
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-sm transition-[border-color,box-shadow] focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/10">
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
                    className="sql-editor min-h-0 flex-1"
                    spellCheck={false}
                    value={sql}
                    onChange={(event) => persistSql(event.target.value)}
                    onKeyDown={onEditorKey}
                    placeholder={"SELECT id, name\nFROM public.users\nWHERE active = true"}
                    disabled={!browseId}
                  />
                  <div className="flex shrink-0 justify-end border-t border-border bg-raised p-2">
                    <Button
                      type="button"
                      variant="primary"
                      className="gap-2"
                      disabled={!canRun || running}
                      onClick={() => void onRun()}
                    >
                      <Play className="size-3.5 fill-current" aria-hidden="true" />
                      {running ? messages.common.running : messages.common.run}
                    </Button>
                  </div>
                </div>
              </section>
            </SplitLayout>
          </div>
        </SplitLayout>
      </Panel>

      {isResultOpen ? (
        <div
          className="fixed inset-0 z-[100] grid place-items-center bg-workspace/60 p-3 backdrop-blur-[1px]"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setIsResultOpen(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="query-result-title"
            className="flex h-[90vh] w-[96vw] max-w-[90rem] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xl"
            style={{ transform: `translate(${dialogOffset.x}px, ${dialogOffset.y}px)` }}
          >
            <header
              className="flex min-h-12 cursor-move select-none items-center justify-between border-b border-border px-4"
              onMouseDown={onDialogHeaderDown}
            >
              <div>
                <h2 id="query-result-title" className="text-sm font-semibold text-text">
                  {messages.query.resultTitle}
                </h2>
              </div>
              <button
                type="button"
                className="grid size-8 place-items-center rounded-lg text-text-secondary outline-none transition-colors hover:bg-subtle hover:text-text focus-visible:ring-2 focus-visible:ring-accent/40"
                aria-label={messages.common.close}
                title={messages.common.close}
                onClick={() => setIsResultOpen(false)}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </header>

            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border bg-raised px-4 py-2">
              <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-text-secondary">
                <span>{messages.query.preview}</span>
                <input
                  className="field-control technical w-16 text-center"
                  type="number"
                  min={1}
                  max={500}
                  value={limit}
                  onChange={(event) => setLimit(Number(event.target.value) || 100)}
                />
              </label>
              <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-text-secondary">
                <span>{messages.common.delimiter}</span>
                <input
                  className="field-control technical w-16 text-center"
                  value={delimiter}
                  onChange={(event) => setDelimiter(event.target.value)}
                  placeholder=","
                  title={messages.connectionsPage.delimiterTitle}
                  required
                />
              </label>
              <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-text-secondary">
                <input
                  className="field-control"
                  type="checkbox"
                  checked={header}
                  onChange={(event) => setHeader(event.target.checked)}
                />
                {messages.common.header}
              </label>
            </div>

            <div className="min-h-72 flex-1 overflow-hidden p-4">
              {running ? (
                <div className="grid h-full min-h-64 place-items-center text-sm text-text-tertiary">
                  {messages.common.running}
                </div>
              ) : error ? (
                <NoticeBanner>{error}</NoticeBanner>
              ) : result?.columns.length ? (
                <div className="flex h-full min-h-64 flex-col gap-3">
                  {info ? <NoticeBanner tone="ok">{info}</NoticeBanner> : null}
                  <DataGrid className="min-h-0 flex-1" headers={result.columns}>
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
                </div>
              ) : (
                <div className="grid h-full min-h-64 place-items-center text-sm text-text-tertiary">
                  {info || messages.empty.preview}
                </div>
              )}
            </div>

            <footer className="flex justify-end gap-2 border-t border-border bg-raised px-4 py-3">
              <Button type="button" variant="secondary" onClick={() => setIsResultOpen(false)}>
                {messages.common.close}
              </Button>
              <Button
                type="button"
                variant="primary"
                disabled={!canExtract || extracting}
                onClick={() => void onExtract()}
              >
                {extracting ? messages.connectionsPage.extracting : messages.query.resultFile}
              </Button>
            </footer>
          </section>
        </div>
      ) : null}
    </PageShell>
  );
}
