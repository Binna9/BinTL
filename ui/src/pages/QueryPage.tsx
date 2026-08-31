import {
  PointerEvent as ReactPointerEvent,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BookmarkPlus, FileDown, ScrollText, Play, RefreshCw, Table2 } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { CatalogTree } from "@/components/CatalogTree";
import { ConnectionInfoPanel } from "@/components/ConnectionInfoPanel";
import {
  columnWidthsForContent,
  DataGrid,
  EmptyGridRow,
  GridCell,
  GridRow,
} from "@/components/DataGrid";
import { AppDialog } from "@/components/AppDialog";
import { LiveTicker } from "@/components/LiveTicker";
import { LogDialog } from "@/components/LogDialog";
import { PageHeader, PageShell } from "@/components/PageShell";
import { SplitLayout } from "@/components/SplitLayout";
import { SqlEditor, type SqlEditorHandle } from "@/components/SqlEditor";
import { Button, ActionAnchor } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { ResizeGrip } from "@/components/ui/resize-grip";
import { Select } from "@/components/ui/select";
import { PaneHeader } from "@/components/ui/pane-header";
import { Panel } from "@/components/ui/panel";
import { useConnectionColumns } from "@/hooks/useConnectionColumns";
import { useConnections } from "@/hooks/useConnections";
import { isExtractActive } from "@/hooks/useExtracts";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { DELIMITER_VALUES } from "@/lib/delimiter";
import { layout } from "@/lib/layout";
import { toastError, toastSuccess } from "@/lib/notifications";
import { selectableClass } from "@/lib/selectable";
import { extractApi } from "@/services/extractApi";
import { queryApi } from "@/services/queryApi";
import { chipApi } from "@/services/chipApi";
import type { CatalogSelection } from "@/types/connection";
import type { ExtractRecord } from "@/types/extract";
import type { QueryResult } from "@/types/query";

function draftSelect(table: string, columns: string[]): string {
  const list = columns.length ? columns.map((column) => `  ${column}`).join(",\n") : "  *";
  return `SELECT\n${list}\nFROM ${table}`;
}

const PREVIEW_LIMITS = [10, 20, 50, 100, 1000] as const;
const SQL_PLACEHOLDER = "SELECT id, name\nFROM public.users\nWHERE active = true";

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
  const editorRef = useRef<SqlEditorHandle>(null);
  const sqlRef = useRef("");
  const sqlByConnection = useRef<Record<string, string>>({});

  const { connections } = useConnections();
  const [browseId, setBrowseId] = useState(params.get("connection") ?? "");
  const [selected, setSelected] = useState<CatalogSelection | null>(null);
  const { connectionColumns, columnsLoading, refreshColumns } =
    useConnectionColumns(browseId, selected);
  const [picked, setPicked] = useState<string[]>([]);
  const [sql, setSql] = useState("");
  sqlRef.current = sql;
  const [delimiter, setDelimiter] = useState(",");
  const delimiterOptions = useMemo(
    () =>
      DELIMITER_VALUES.map((value) => ({
        value,
        label: value === " " ? messages.format.space : value === "tab" ? "tab" : value,
      })),
    [messages],
  );
  const [header, setHeader] = useState(true);
  const [addSequence, setAddSequence] = useState(false);
  const [limit, setLimit] = useState(100);
  const [search, setSearch] = useState("");
  const [running, setRunning] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [info, setInfo] = useState("");
  const [isResultOpen, setIsResultOpen] = useState(false);
  const [isLogOpen, setIsLogOpen] = useState(false);
  const [isRegisterOpen, setIsRegisterOpen] = useState(false);
  const [registerName, setRegisterName] = useState("");
  const [registerBusy, setRegisterBusy] = useState(false);
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
  const toastedExtractFail = useRef("");
  const toastedExtractSuccess = useRef("");

  const active = useMemo(
    () => connections.find((connection) => connection.id === browseId),
    [connections, browseId],
  );

  useEffect(() => {
    if (!browseId) {
      setSelected(null);
      setPicked([]);
    }
  }, [browseId]);

  useEffect(() => setPicked([]), [browseId, selected]);

  useEffect(() => {
    const table = params.get("table");
    const database = params.get("database");
    if (!browseId || !table || !database) return;
    if (sqlByConnection.current[browseId]) return;
    persistSql(draftSelect(table, []));
  }, [browseId]);

  useEffect(() => {
    if (!isResultOpen) {
      setIsLogOpen(false);
      setIsRegisterOpen(false);
    }
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
    if (!extractId) return;
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
        if (isResultOpen) setExtractLog(logs.text);
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
    if (!extractId || !isResultOpen) return;
    void extractApi
      .getLogs(extractId)
      .then((logs) => setExtractLog(logs.text))
      .catch(() => {});
  }, [extractId, isResultOpen]);

  useEffect(() => {
    if (!extractRow || extractRow.status !== "failed") return;
    if (toastedExtractFail.current === extractRow.id) return;
    toastedExtractFail.current = extractRow.id;
    toastError(messages.errors.extract, extractRow.error_message);
  }, [extractRow, messages]);

  useEffect(() => {
    if (!extractRow || extractRow.status !== "succeeded") return;
    if (toastedExtractSuccess.current === extractRow.id) return;
    toastedExtractSuccess.current = extractRow.id;
    toastSuccess(
      messages.query.extractComplete,
      messages.query.extractDone(extractRow.row_count ?? 0),
    );
  }, [extractRow, messages]);

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
    sqlRef.current = next;
    if (browseId) sqlByConnection.current[browseId] = next;
  }

  function onPickConnection(id: string) {
    if (browseId === id) {
      sqlByConnection.current[browseId] = sql;
      setBrowseId("");
      setSelected(null);
      setPicked([]);
      setResult(null);
      setSql("");
      sqlRef.current = "";
      return;
    }
    if (browseId) sqlByConnection.current[browseId] = sql;
    setBrowseId(id);
    setSelected(null);
    setPicked([]);
    setResult(null);
    const saved = sqlByConnection.current[id] ?? "";
    setSql(saved);
    sqlRef.current = saved;
  }

  function onPickTable(next: CatalogSelection | null) {
    setSelected(next);
    setPicked([]);
  }

  function insertAtCursor(text: string) {
    editorRef.current?.insertAtCursor(text);
  }

  function applyDraft(columnsToUse: string[]) {
    if (!selected) return;
    persistSql(draftSelect(selected.qualified, columnsToUse));
  }

  async function onRefreshSql() {
    persistSql("");
    if (!selected) return;
    const columns = await refreshColumns();
    if (!columns) return;
    const names = new Set(columns.map((column) => column.name));
    setPicked(picked.filter((name) => names.has(name)));
  }

  function toggleColumn(name: string) {
    setPicked((current) =>
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name],
    );
  }

  async function runQuery(previewLimit: number, openFresh: boolean) {
    if (!browseId || !sqlRef.current.trim()) return;
    const seq = ++runSeq.current;
    if (openFresh) {
      setIsResultOpen(true);
      setIsLogOpen(false);
    }
    setSearch("");
    setRunning(true);
    setInfo("");
    const logId = crypto.randomUUID();
    setQueryLogId(logId);
    setQueryLog(
      `${new Date().toISOString()}  info   started  preview_limit=${previewLimit}\n`,
    );
    try {
      const outcome = await queryApi.runQuery(
        browseId,
        sqlRef.current,
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
      toastError(messages.errors.query, err);
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
    try {
      const created = await extractApi.createExtract({
        connection_id: browseId,
        table: selected?.qualified || "query",
        database: selected?.database,
        sql: sqlRef.current,
        delimiter,
        header,
        add_sequence: addSequence,
      });
      setExtractId(created.id);
      setExtractRow(created);
      setExtractLog("");
    } catch (err) {
      toastError(messages.errors.extract, err);
    } finally {
      setExtracting(false);
    }
  }

  function openRegister() {
    setRegisterName(selected?.qualified || messages.workspace.untitledExtract(1));
    setIsRegisterOpen(true);
  }

  async function onRegisterTask() {
    if (!browseId || !registerName.trim() || !sql.trim()) return;
    setRegisterBusy(true);
    try {
      await chipApi.register({
        name: registerName.trim(),
        kind: "extract",
        extract: {
          connection_id: browseId,
          source: {
            type: "query",
            sql,
            ...(selected?.database ? { database: selected.database } : {}),
          },
          delimiter,
          header,
        },
      });
      setIsRegisterOpen(false);
      toastSuccess(messages.query.taskRegistered);
    } catch (err) {
      toastError(messages.workspace.saveChipError, err);
    } finally {
      setRegisterBusy(false);
    }
  }

  const canRun = Boolean(browseId && sql.trim());
  const extractBusy = extracting || (extractRow ? isExtractActive(extractRow.status) : false);
  const canExtract = canRun && result?.kind !== "exec" && !extractBusy;
  const canRegister = canRun && result?.kind !== "exec" && Boolean(registerName.trim() && sql.trim());
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
      .map((row, index) => ({ row, index, line: fileLine(index, header), seq: index + 1 }))
      .filter(({ row, seq }) => {
        if (!searchLower) return true;
        if (addSequence && String(seq).includes(searchNeedle)) return true;
        return row.some((cell) => cell.toLowerCase().includes(searchLower));
      });
  }, [addSequence, header, result, searchLower, searchNeedle]);
  const resultWidths = useMemo(() => {
    if (!result?.columns.length) return undefined;
    const dataWidths = columnWidthsForContent(result.columns, result.rows);
    return addSequence ? [layout.grid.minColumnWidth, ...dataWidths] : dataWidths;
  }, [addSequence, result]);

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

      <Panel tall className="overflow-hidden">
        <SplitLayout
          className="min-h-0 flex-1"
          defaultSizes={[layout.split.sidebar]}
        >
          <aside className="flex h-full min-h-0 flex-col overflow-hidden">
            <SplitLayout
              className="h-full"
              direction="vertical"
              defaultSizes={[layout.split.connections]}
              minSize={layout.split.minStack}
            >
              <div className="flex h-full min-h-0 flex-col overflow-hidden">
                <PaneHeader title={messages.common.connections} meta={messages.common.count(connections.length)} />
                <div className="scroll-pane min-h-0 flex-1 overflow-y-auto bg-surface">
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
              <div className="flex h-full min-h-0 flex-col overflow-hidden">
                <PaneHeader title={messages.common.catalog} />
                <div className="scroll-pane min-h-0 flex-1 overflow-y-auto bg-surface">
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
              selected={selected}
            />

            <SplitLayout className="min-h-0 flex-1" defaultSizes={[layout.split.columns]}>
              <section className="flex h-full min-h-0 flex-col overflow-hidden">
                <PaneHeader title={messages.common.columns} meta={`${connectionColumns.length}`} />
                <div className="scroll-pane min-h-0 flex-1 overflow-y-auto bg-surface">
                  {connectionColumns.length === 0 ? (
                    <p className="p-3 text-xs text-text-tertiary">{messages.query.columnsHint}</p>
                  ) : (
                    <ul className="m-0 list-none p-0">
                      {connectionColumns.map((column) => (
                        <li key={column.name} className="border-b border-border last:border-b-0">
                          <label
                            className={cn(
                              "flex cursor-pointer items-start gap-2 overflow-hidden px-3 py-1.5 select-none",
                              selectableClass(picked.includes(column.name)),
                            )}
                          >
                            <input
                              className="field-control mt-0.5"
                              type="checkbox"
                              checked={picked.includes(column.name)}
                              onChange={() => toggleColumn(column.name)}
                            />
                            <span
                              className="min-w-0 flex-1 overflow-hidden text-left"
                              onDoubleClick={() => insertAtCursor(column.name)}
                              title={messages.query.insertHint}
                            >
                              <span className="block truncate text-xs">{column.name}</span>
                              <span className="block truncate text-[11px] text-text-tertiary">
                                {column.data_type}
                                {column.nullable ? "" : " · NOT NULL"}
                              </span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>

              <section className="flex h-full min-h-0 flex-col overflow-hidden bg-raised p-3">
                <div
                  ref={editorBoxRef}
                  className={cn(
                    "flex max-w-full min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-sm transition-[border-color,box-shadow] focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/10",
                    editorSize ? "shrink-0" : undefined,
                  )}
                  style={
                    editorSize
                      ? { width: editorSize.w, height: editorSize.h, maxWidth: "100%", maxHeight: "100%" }
                      : undefined
                  }
                >
                  <PaneHeader
                    title="SQL"
                    description={messages.query.runHint}
                    actions={
                      <>
                        <div className="flex items-center gap-1">
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
                            {messages.query.applyStar}
                          </Button>
                          <Button
                            type="button"
                            variant="quiet"
                            disabled={!browseId || columnsLoading}
                            title={messages.common.refresh}
                            onClick={() => void onRefreshSql()}
                          >
                            <RefreshCw className="size-3.5" aria-hidden="true" />
                            {messages.common.refresh}
                          </Button>
                        </div>
                        <Button
                          type="button"
                          variant="primary"
                          className="ml-6 shrink-0 gap-2"
                          disabled={!canRun || running}
                          onClick={() => void onRun()}
                        >
                          <Play className="size-3.5 fill-current" aria-hidden="true" />
                          {running ? messages.common.running : messages.common.run}
                        </Button>
                      </>
                    }
                  />
                  <div className="relative min-h-0 flex-1">
                    <SqlEditor
                      ref={editorRef}
                      value={sql}
                      placeholder={SQL_PLACEHOLDER}
                      disabled={!browseId}
                      driver={active?.driver}
                      table={selected?.qualified}
                      columns={connectionColumns}
                      onChange={persistSql}
                      onRun={() => void onRun()}
                      onClear={() => void onRefreshSql()}
                    />
                    <ResizeGrip
                      label={messages.common.resizeEditor}
                      onPointerDown={onEditorResizeDown}
                      onDoubleClick={() => setEditorSize(null)}
                    />
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
              className="gap-2"
              disabled={!canExtract}
              onClick={() => void onExtract()}
            >
              <FileDown className="size-3.5" aria-hidden="true" />
              {extractBusy ? messages.connectionsPage.extracting : messages.query.resultFile}
            </Button>
            <Button
              type="button"
              className="gap-2"
              disabled={!canRun || result?.kind === "exec"}
              onClick={openRegister}
            >
              <BookmarkPlus className="size-3.5" aria-hidden="true" />
              {messages.query.registerTask}
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
              <div
                className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-text-secondary"
                title={messages.connectionsPage.delimiterTitle}
              >
                <span>{messages.common.delimiter}</span>
                <Select
                  editable
                  className="!w-[6.5rem] technical"
                  value={delimiter}
                  placeholder={messages.query.delimiterPlaceholder}
                  options={delimiterOptions}
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
              <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-text-secondary">
                <input
                  className="field-control"
                  type="checkbox"
                  checked={addSequence}
                  onChange={(event) => setAddSequence(event.target.checked)}
                />
                {messages.common.addSequence}
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

            <div className="min-h-72 min-w-0 flex-1 overflow-hidden p-4">
              {running ? (
                <div className="grid h-full min-h-64 place-items-center text-sm text-text-tertiary">
                  {messages.common.running}
                </div>
              ) : result?.columns.length ? (
                <div className="flex h-full min-h-64 min-w-0 flex-col gap-3">
                  <DataGrid
                    className="min-h-0 min-w-0 flex-1"
                    headers={
                      addSequence
                        ? [messages.query.rowNo, ...result.columns]
                        : result.columns
                    }
                    columnWidths={resultWidths}
                  >
                    {result.rows.length === 0 ? (
                      <EmptyGridRow
                        cols={result.columns.length + (addSequence ? 1 : 0)}
                        text={messages.empty.preview}
                      />
                    ) : visibleRows.length === 0 ? (
                      <EmptyGridRow
                        cols={result.columns.length + (addSequence ? 1 : 0)}
                        text={
                          searchedLine > result.rows.length
                            ? messages.query.searchBeyondPreview(searchedLine, result.rows.length)
                            : messages.query.searchEmpty
                        }
                      />
                    ) : (
                      visibleRows.map(({ row, index, seq }) => (
                        <GridRow key={index}>
                          {addSequence ? (
                            <GridCell mono muted>
                              {highlightMatch(String(seq), searchNeedle)}
                            </GridCell>
                          ) : null}
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

      <AppDialog
        open={isRegisterOpen}
        title={messages.query.registerTaskTitle}
        icon={<BookmarkPlus className="size-4 text-accent" aria-hidden="true" />}
        className="w-[min(22rem,92vw)]"
        minWidth={320}
        minHeight={240}
        zIndex={120}
        defaultOffset={{ x: 40, y: 28 }}
        onClose={() => setIsRegisterOpen(false)}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setIsRegisterOpen(false)}>
              {messages.common.cancel}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={!canRegister || registerBusy}
              onClick={() => void onRegisterTask()}
            >
              {registerBusy ? messages.common.saving : messages.common.save}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 p-4">
          <p className="text-[11px] leading-5 text-text-tertiary">{messages.query.registerTaskHint}</p>
          <FormField label={messages.workspace.chipName}>
            <input
              className="field-control"
              value={registerName}
              autoFocus
              placeholder={messages.query.namePlaceholder}
              onChange={(event) => setRegisterName(event.target.value)}
            />
          </FormField>
          <dl className="space-y-2 border-t border-border/60 pt-3 text-[11px] text-text-tertiary">
            <div className="flex gap-2">
              <dt className="w-14 shrink-0">{messages.workspace.connection}</dt>
              <dd className="min-w-0 truncate text-text-secondary">{active?.name ?? "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-14 shrink-0">{messages.workspace.sql}</dt>
              <dd className="line-clamp-3 min-w-0 font-mono text-[10px] leading-4 text-text-secondary">
                {sql.trim() || "—"}
              </dd>
            </div>
          </dl>
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
