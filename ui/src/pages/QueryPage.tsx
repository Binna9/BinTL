import {
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ScrollText, Play, RefreshCw, Table2 } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { CatalogTree } from "@/components/CatalogTree";
import { ConnectionInfoPanel } from "@/components/ConnectionInfoPanel";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { AppDialog } from "@/components/AppDialog";
import { LiveTicker } from "@/components/LiveTicker";
import { LogDialog } from "@/components/LogDialog";
import { PageHeader, PageShell } from "@/components/PageShell";
import { SplitLayout } from "@/components/SplitLayout";
import { Button, ActionAnchor } from "@/components/ui/button";
import { ResizeGrip } from "@/components/ui/resize-grip";
import { Select } from "@/components/ui/select";
import { NoticeBanner } from "@/components/ui/notice-banner";
import { PaneHeader } from "@/components/ui/pane-header";
import { Panel } from "@/components/ui/panel";
import { useConnectionColumns } from "@/hooks/useConnectionColumns";
import { useConnections } from "@/hooks/useConnections";
import { isExtractActive } from "@/hooks/useExtracts";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { layout } from "@/lib/layout";
import { selectableClass } from "@/lib/selectable";
import { extractApi } from "@/services/extractApi";
import { queryApi } from "@/services/queryApi";
import type { CatalogSelection } from "@/types/connection";
import type { ExtractRecord } from "@/types/extract";
import type { QueryResult } from "@/types/query";

function sqlStorageKey(id: string): string {
  return `bintl.query.sql.${id}`;
}

function draftSelect(table: string, columns: string[]): string {
  const list = columns.length ? columns.map((column) => `  ${column}`).join(",\n") : "  *";
  return `SELECT\n${list}\nFROM ${table}`;
}

const PREVIEW_LIMITS = [10, 20, 50, 100, 1000] as const;
const DELIMITER_OPTIONS = [",", "|", ";", "tab", "^"] as const;
const SQL_PANE_CHROME = 96;

function delimiterChar(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "tab" || trimmed === "\\t") return "\t";
  if (trimmed.length === 1) return trimmed;
  return raw.length === 1 ? raw : null;
}

function fileLine(rowIndex: number, hasHeader: boolean): number {
  return rowIndex + (hasHeader ? 2 : 1);
}

function logTickerLines(text: string): string[] {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s{2,}/);
      return parts.length >= 3 ? parts.slice(2).join("  ") : line;
    });
}

function highlightMatch(text: string, query: string): ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle || !lower.includes(needle)) return text;
  const parts: ReactNode[] = [];
  let from = 0;
  let key = 0;
  while (from <= text.length) {
    const at = lower.indexOf(needle, from);
    if (at < 0) {
      parts.push(text.slice(from));
      break;
    }
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <mark key={key} className="rounded-sm bg-accent/25 p-0 text-inherit">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    key += 1;
    from = at + needle.length;
    if (needle.length === 0) break;
  }
  return parts;
}

export function QueryPage() {
  const { messages } = useLanguage();
  const [params] = useSearchParams();
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const { connections, connectionsError } = useConnections();
  const [browseId, setBrowseId] = useState(params.get("connection") ?? "");
  const [selected, setSelected] = useState<CatalogSelection | null>(null);
  const { connectionColumns, connectionColumnsError, columnsLoading, refreshColumns } =
    useConnectionColumns(browseId, selected);
  const [picked, setPicked] = useState<string[]>([]);
  const [sql, setSql] = useState("");
  const [delimiter, setDelimiter] = useState(",");
  const [header, setHeader] = useState(true);
  const [limit, setLimit] = useState(100);
  const [search, setSearch] = useState("");
  const [running, setRunning] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [isResultOpen, setIsResultOpen] = useState(false);
  const [isLogOpen, setIsLogOpen] = useState(false);
  const [extractId, setExtractId] = useState("");
  const [extractRow, setExtractRow] = useState<ExtractRecord | null>(null);
  const [extractLog, setExtractLog] = useState("");
  const [queryLogId, setQueryLogId] = useState("");
  const [queryLog, setQueryLog] = useState("");
  const [runElapsed, setRunElapsed] = useState(0);
  const editorBoxRef = useRef<HTMLDivElement>(null);
  const editorResize = useRef<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const [editorSize, setEditorSize] = useState<{ w: number; h: number } | null>(null);
  const runSeq = useRef(0);

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
    if (!isResultOpen) setIsLogOpen(false);
  }, [isResultOpen]);

  useEffect(() => {
    function maxEditorWidth() {
      const host = editorBoxRef.current?.parentElement;
      if (!host) return Number.POSITIVE_INFINITY;
      const style = getComputedStyle(host);
      return Math.max(
        320,
        host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      );
    }

    function endResize() {
      const main = editorBoxRef.current?.closest("main");
      if (main instanceof HTMLElement) main.style.overflowAnchor = "";
      editorResize.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    }

    function onPointerMove(event: PointerEvent) {
      const resize = editorResize.current;
      if (!resize) return;
      if (event.buttons === 0) {
        endResize();
        return;
      }
      setEditorSize({
        w: Math.min(maxEditorWidth(), Math.max(320, resize.w + event.clientX - resize.x)),
        h: Math.max(200, resize.h + event.clientY - resize.y),
      });
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endResize);
    window.addEventListener("pointercancel", endResize);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endResize);
      window.removeEventListener("pointercancel", endResize);
    };
  }, []);

  useEffect(() => {
    if (!extractId || !isResultOpen) return;
    let cancelled = false;
    let timer: number | undefined;

    async function refreshExtract() {
      try {
        const [row, logs] = await Promise.all([
          extractApi.getExtract(extractId),
          extractApi.getLogs(extractId),
        ]);
        if (cancelled) return;
        setExtractRow(row);
        setExtractLog(logs.text);
        if (isExtractActive(row.status)) {
          timer = window.setTimeout(() => void refreshExtract(), 1000);
        }
      } catch {
        if (!cancelled) {
          timer = window.setTimeout(() => void refreshExtract(), 1500);
        }
      }
    }

    void refreshExtract();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [extractId, isResultOpen]);

  useEffect(() => {
    if (!running) {
      setRunElapsed(0);
      return;
    }
    const timer = window.setInterval(() => {
      setRunElapsed((value) => value + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (!queryLogId || !isResultOpen) return;
    let cancelled = false;
    let timer: number | undefined;

    async function refreshQueryLog() {
      try {
        const logs = await queryApi.getLogs(queryLogId);
        if (!cancelled && logs.text) setQueryLog(logs.text);
      } catch {
        /* file may not exist yet */
      }
      if (!cancelled && running) {
        timer = window.setTimeout(() => void refreshQueryLog(), 400);
      }
    }

    void refreshQueryLog();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [queryLogId, isResultOpen, running]);

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

  async function onRefreshSql() {
    if (!selected) return;
    const columns = await refreshColumns();
    if (!columns) return;
    const names = new Set(columns.map((column) => column.name));
    const nextPicked = picked.filter((name) => names.has(name));
    setPicked(nextPicked);
    persistSql(draftSelect(selected.qualified, nextPicked));
  }

  function toggleColumn(name: string) {
    setPicked((current) =>
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name],
    );
  }

  async function runQuery(previewLimit: number, openFresh: boolean) {
    if (!browseId || !sql.trim()) return;
    const seq = ++runSeq.current;
    if (openFresh) {
      setIsResultOpen(true);
      setIsLogOpen(false);
    }
    setSearch("");
    setRunning(true);
    setError("");
    setInfo("");
    const logId = crypto.randomUUID();
    setQueryLogId(logId);
    setQueryLog(
      `${new Date().toISOString()}  info   started  preview_limit=${previewLimit}\n`,
    );
    try {
      const outcome = await queryApi.runQuery(
        browseId,
        sql,
        previewLimit,
        selected?.database,
        logId,
      );
      if (seq !== runSeq.current) return;
      setResult(outcome);
      setInfo(
        outcome.kind === "exec"
          ? messages.query.executed(outcome.row_count, outcome.elapsed_ms)
          : messages.query.result(outcome.row_count, outcome.truncated, outcome.elapsed_ms),
      );
    } catch (err) {
      if (seq !== runSeq.current) return;
      setResult(null);
      setError(err instanceof Error ? err.message : messages.errors.query);
    } finally {
      if (seq === runSeq.current) setRunning(false);
    }
  }

  async function onRun() {
    await runQuery(limit, true);
  }

  async function onExtract() {
    if (!browseId) return;
    setExtracting(true);
    setError("");
    try {
      const created = await extractApi.createExtract({
        connection_id: browseId,
        table: selected?.qualified || "query",
        database: selected?.database,
        sql,
        delimiter,
        header,
      });
      setExtractId(created.id);
      setExtractRow(created);
      setExtractLog("");
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
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Backspace") {
      event.preventDefault();
      void onRefreshSql();
    }
  }

  const canRun = Boolean(browseId && sql.trim());
  const extractBusy = extracting || (extractRow ? isExtractActive(extractRow.status) : false);
  const canExtract = canRun && result?.kind !== "exec" && !extractBusy;
  const tickerLive = running || extractBusy;
  const tickerItems = useMemo(() => {
    const items: string[] = [];
    if (running) {
      items.push(messages.query.runningFor(runElapsed));
      items.push(messages.query.runningPreview(limit));
    } else if (info) items.push(info);
    if (extractRow?.status === "queued") items.push(messages.query.extractQueued);
    if (extractRow?.status === "running" && extractRow.row_count != null) {
      items.push(messages.extracts.writing(extractRow.row_count));
    }
    if (extractRow?.status === "succeeded") {
      items.push(messages.query.extractDone(extractRow.row_count ?? 0));
    }
    if (extractRow?.status === "failed" && extractRow.error_message) {
      items.push(extractRow.error_message);
    }
    items.push(...logTickerLines(queryLog));
    items.push(...logTickerLines(extractLog));
    return items.filter(Boolean);
  }, [extractLog, extractRow, info, limit, messages, queryLog, runElapsed, running]);
  const delimiterNeedle = delimiterChar(delimiter);
  const searchNeedle = search.trim();
  const searchLower = searchNeedle.toLowerCase();
  const searchedLine = /^\d+$/.test(searchNeedle) ? Number(searchNeedle) : 0;
  const visibleRows = useMemo(() => {
    if (!result?.rows) return [];
    return result.rows
      .map((row, index) => ({ row, index, line: fileLine(index, header) }))
      .filter(({ row, line }) => {
        if (!searchLower) return true;
        if (String(line).includes(searchNeedle)) return true;
        return row.some((cell) => cell.toLowerCase().includes(searchLower));
      });
  }, [header, result, searchLower, searchNeedle]);

  function onEditorResizeDown(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    const box = editorBoxRef.current;
    if (!box) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    editorResize.current = {
      x: event.clientX,
      y: event.clientY,
      w: box.offsetWidth,
      h: box.offsetHeight,
    };
    const main = box.closest("main");
    if (main instanceof HTMLElement) main.style.overflowAnchor = "none";
    document.body.style.userSelect = "none";
    document.body.style.cursor = "se-resize";
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

      <Panel>
        <SplitLayout
          fill={false}
          style={{
            minHeight: editorSize
              ? `max(${layout.page.workspaceHeight}, ${editorSize.h + SQL_PANE_CHROME}px)`
              : layout.page.workspaceHeight,
          }}
          defaultSizes={[layout.split.sidebar]}
        >
          <aside className="flex min-h-0 flex-col">
            <SplitLayout
              fill={false}
              className="min-h-full"
              direction="vertical"
              defaultSizes={[layout.split.connections]}
              minSize={layout.split.minStack}
            >
              <div className="flex flex-col">
                <PaneHeader title={messages.common.connections} meta={messages.common.count(connections.length)} />
                <div className="bg-surface">
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
              <div className="flex flex-col">
                <PaneHeader title={messages.common.catalog} />
                <div className="bg-surface">
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

          <div className="flex min-h-0 min-w-0 flex-col">
            <ConnectionInfoPanel
              connection={active}
              selectedTable={selected?.qualified}
            />

            <SplitLayout fill={false} className="min-h-[28rem]" defaultSizes={[layout.split.columns]}>
              <section className="flex flex-col">
                <PaneHeader title={messages.common.columns} meta={`${connectionColumns.length}`} />
                <div className="bg-surface">
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

              <section className="flex min-h-[28rem] flex-col bg-raised p-3">
                <div
                  ref={editorBoxRef}
                  className={cn(
                    "flex max-w-full flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-sm transition-[border-color,box-shadow] focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/10",
                    editorSize ? "shrink-0" : "min-h-[24rem] flex-1",
                  )}
                  style={
                    editorSize
                      ? { width: editorSize.w, height: editorSize.h, maxWidth: "100%" }
                      : undefined
                  }
                >
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
                          disabled={!selected || columnsLoading}
                          title={messages.common.refresh}
                          onClick={() => void onRefreshSql()}
                        >
                          <RefreshCw className="size-3.5" aria-hidden="true" />
                          {messages.common.refresh}
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
                  <div className="relative min-h-0 flex-1">
                    <textarea
                      ref={editorRef}
                      className="sql-editor h-full min-h-0 pb-6"
                      spellCheck={false}
                      value={sql}
                      onChange={(event) => persistSql(event.target.value)}
                      onKeyDown={onEditorKey}
                      placeholder={"SELECT id, name\nFROM public.users\nWHERE active = true"}
                      disabled={!browseId}
                    />
                    <ResizeGrip
                      label={messages.common.resizeEditor}
                      onPointerDown={onEditorResizeDown}
                      onDoubleClick={() => setEditorSize(null)}
                    />
                  </div>
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

      <AppDialog
        open={isResultOpen}
        title={messages.query.resultTitle}
        icon={<Table2 className="size-4 text-accent" aria-hidden="true" />}
        className="h-[90vh] w-[96vw] max-w-[90rem]"
        minWidth={560}
        minHeight={360}
        onClose={() => setIsResultOpen(false)}
        headerExtra={
          <>
            <LiveTicker items={tickerItems} active={tickerLive} />
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-text-secondary outline-none transition-colors hover:bg-subtle hover:text-text focus-visible:ring-2 focus-visible:ring-accent/40"
              onClick={() => setIsLogOpen(true)}
            >
              <ScrollText className="size-3.5" aria-hidden="true" />
              {messages.query.viewLog}
            </button>
          </>
        }
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setIsResultOpen(false)}>
              {messages.common.close}
            </Button>
            {extractRow?.status === "succeeded" ? (
              <ActionAnchor
                variant="secondary"
                href={extractApi.getDownloadUrl(extractRow.id)}
              >
                {messages.common.download}
              </ActionAnchor>
            ) : null}
            <Button
              type="button"
              variant="primary"
              disabled={!canExtract}
              onClick={() => void onExtract()}
            >
              {extractBusy ? messages.connectionsPage.extracting : messages.query.resultFile}
            </Button>
          </>
        }
      >
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border bg-surface px-4 py-2">
              <div className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-text-secondary">
                <span>{messages.query.preview}</span>
                <Select
                  className="!w-[4.75rem] technical"
                  value={String(limit)}
                  disabled={running || !canRun}
                  options={PREVIEW_LIMITS.map((value) => ({
                    value: String(value),
                    label: String(value),
                  }))}
                  onChange={(next) => {
                    const parsed = Number(next);
                    setLimit(parsed);
                    void runQuery(parsed, false);
                  }}
                />
              </div>
              <div className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-text-secondary">
                <span>{messages.common.delimiter}</span>
                <Select
                  className="!w-[6.5rem] technical"
                  value={delimiter}
                  options={DELIMITER_OPTIONS.map((value) => ({
                    value,
                    label: value,
                  }))}
                  onChange={setDelimiter}
                />
              </div>
              <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-text-secondary">
                <input
                  className="field-control"
                  type="checkbox"
                  checked={header}
                  onChange={(event) => setHeader(event.target.checked)}
                />
                {messages.common.header}
              </label>
              <label className="ml-auto flex min-w-48 flex-1 items-center gap-2 whitespace-nowrap text-xs text-text-secondary sm:max-w-xs">
                <span>{messages.query.search}</span>
                <input
                  className="field-control min-w-0 flex-1"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={messages.query.searchPlaceholder}
                />
                {searchNeedle && result?.rows.length ? (
                  <span className="technical shrink-0 text-[11px] text-text-tertiary">
                    {visibleRows.length}/{result.rows.length}
                  </span>
                ) : null}
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
                  <DataGrid
                    className="min-h-0 flex-1"
                    headers={[messages.query.rowNo, ...result.columns]}
                    columnWidths={[
                      layout.grid.minColumnWidth,
                      ...result.columns.map(() => layout.grid.defaultColumnWidth),
                    ]}
                  >
                    {result.rows.length === 0 ? (
                      <EmptyGridRow cols={result.columns.length + 1} text={messages.empty.preview} />
                    ) : visibleRows.length === 0 ? (
                      <EmptyGridRow
                        cols={result.columns.length + 1}
                        text={
                          searchedLine > result.rows.length
                            ? messages.query.searchBeyondPreview(searchedLine, result.rows.length)
                            : messages.query.searchEmpty
                        }
                      />
                    ) : (
                      visibleRows.map(({ row, index, line }) => (
                        <GridRow key={index}>
                          <GridCell mono muted>
                            {highlightMatch(String(line), searchNeedle)}
                          </GridCell>
                          {row.map((cell, cellIndex) => {
                            const warn = Boolean(
                              delimiterNeedle &&
                                (cell.includes(delimiterNeedle) ||
                                  cell.includes("\n") ||
                                  cell.includes("\r")),
                            );
                            return (
                              <GridCell
                                key={cellIndex}
                                mono
                                warn={warn}
                                title={
                                  warn
                                    ? `${messages.query.delimiterInValue}: ${cell}`
                                    : cell
                                }
                              >
                                {highlightMatch(cell, searchNeedle)}
                              </GridCell>
                            );
                          })}
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
      </AppDialog>

      <LogDialog
        open={isLogOpen}
        title={messages.query.logTitle}
        text={[queryLog, extractLog].filter(Boolean).join("\n\n")}
        onClose={() => setIsLogOpen(false)}
      />
    </PageShell>
  );
}
