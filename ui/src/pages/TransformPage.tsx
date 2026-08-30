import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams } from "react-router-dom";
import {
  BookmarkPlus,
  Braces,
  ChevronRight,
  Database,
  Eye,
  FileDown,
  FileOutput,
  FileSpreadsheet,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import {
  columnWidthsForContent,
  DataGrid,
  EmptyGridRow,
  GridCell,
  GridRow,
} from "@/components/DataGrid";
import { PageHeader, PageShell } from "@/components/PageShell";
import { SplitLayout } from "@/components/SplitLayout";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { MetaField } from "@/components/ui/meta-field";
import { PaneHeader } from "@/components/ui/pane-header";
import { Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { fmtBytes } from "@/lib/format";
import { layout } from "@/lib/layout";
import { toastError } from "@/lib/notifications";
import { selectableClass } from "@/lib/selectable";
import { datasetApi } from "@/services/datasetApi";
import { transformApi } from "@/services/transformApi";
import type { Dataset, DatasetColumn, FramePreview } from "@/types/dataset";
import type {
  StepOp,
  TransformSpecV2,
  TransformStep,
} from "@/types/transform";

const STEP_OPS: StepOp[] = [
  "select",
  "drop",
  "rename",
  "filter",
  "cast",
  "fill_null",
  "sort",
  "unique",
];

const CAST_TYPES = ["Int64", "Int32", "Float64", "Float32", "String", "Boolean"];
const KIND_ORDER = ["upload", "database", "api", "transform"] as const;
const KIND_APPEARANCE = {
  upload: {
    icon: Upload,
    header: "border-accent/20 bg-accent-subtle text-accent",
    count: "bg-accent/10 text-accent",
  },
  database: {
    icon: Database,
    header: "border-success/20 bg-success-subtle text-success",
    count: "bg-success/10 text-success",
  },
  transform: {
    icon: FileOutput,
    header: "border-accent/20 bg-accent-subtle text-accent",
    count: "bg-accent/10 text-accent",
  },
  api: {
    icon: Braces,
    header: "border-warning/20 bg-warning-subtle text-warning",
    count: "bg-warning/10 text-warning",
  },
} as const;

function emptyStep(op: StepOp): TransformStep {
  switch (op) {
    case "select":
    case "drop":
      return { op, columns: [] };
    case "rename":
      return { op, map: {} };
    case "filter":
      return { op, expr: "" };
    case "cast":
      return { op, columns: {} };
    case "fill_null":
      return { op, value: "", columns: [] };
    case "sort":
      return { op, by: [{ column: "", descending: false }] };
    case "unique":
      return { op, subset: [], keep: "first" };
  }
}

function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseRename(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const [from, to] = part.split(":").map((value) => value.trim());
    if (from && to) map[from] = to;
  }
  return map;
}

function formatRename(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([from, to]) => `${from}:${to}`)
    .join(", ");
}

function parseCast(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const [from, to] = part.split(":").map((value) => value.trim());
    if (from && to) map[from] = to;
  }
  return map;
}

function formatCast(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([from, to]) => `${from}:${to}`)
    .join(", ");
}

function usableSteps(steps: TransformStep[]): TransformStep[] {
  return steps.filter((step) => {
    switch (step.op) {
      case "select":
      case "drop":
        return step.columns.length > 0;
      case "rename":
        return Object.keys(step.map).length > 0;
      case "cast":
        return Object.keys(step.columns).length > 0;
      case "filter":
        return step.expr.trim().length > 0;
      case "fill_null":
        return step.columns.length > 0 && step.value.trim().length > 0;
      case "sort":
        return step.by.some((item) => item.column.trim());
      case "unique":
        return true;
    }
  });
}

function specFrom(dataset: Dataset | null, steps: TransformStep[]): TransformSpecV2 {
  return {
    version: 2,
    sink: "parquet",
    read: {
      delimiter: dataset?.delimiter ?? undefined,
      has_header: dataset?.has_header ?? undefined,
    },
    steps: usableSteps(steps),
  };
}

function PreviewGrid({
  preview,
  empty,
}: {
  preview: FramePreview | null;
  empty: string;
}) {
  if (!preview || preview.columns.length === 0) {
    return (
      <DataGrid headers={["—"]}>
        <EmptyGridRow cols={1} text={empty} />
      </DataGrid>
    );
  }
  const headers = preview.columns.map((column) => column.name);
  const widths = columnWidthsForContent(headers, preview.rows);
  return (
    <DataGrid className="h-full min-h-64" headers={headers} columnWidths={widths}>
      {preview.rows.length === 0 ? (
        <EmptyGridRow cols={headers.length} text={empty} />
      ) : (
        preview.rows.map((row, index) => (
          <GridRow key={index}>
            {headers.map((_, cellIndex) => (
              <GridCell key={cellIndex} mono title={row[cellIndex] ?? ""}>
                {row[cellIndex] ?? ""}
              </GridCell>
            ))}
          </GridRow>
        ))
      )}
    </DataGrid>
  );
}

export function TransformPage() {
  const { messages } = useLanguage();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [datasetId, setDatasetId] = useState<string>();
  const [transformId, setTransformId] = useState<string>();
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<TransformStep[]>([]);
  const [sourcePreview, setSourcePreview] = useState<FramePreview | null>(null);
  const [resultPreview, setResultPreview] = useState<FramePreview | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<"source" | "result">("source");
  const [detailTick, setDetailTick] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [expandedKinds, setExpandedKinds] = useState<Set<(typeof KIND_ORDER)[number]>>(
    new Set(),
  );
  const [kindSearch, setKindSearch] = useState<
    Record<(typeof KIND_ORDER)[number], string>
  >({
    upload: "",
    database: "",
    transform: "",
    api: "",
  });
  const [busy, setBusy] = useState(false);
  const [addStepOpen, setAddStepOpen] = useState(false);
  const addStepRef = useRef<HTMLDivElement>(null);
  const addStepMenuRef = useRef<HTMLDivElement>(null);
  const [addStepPos, setAddStepPos] = useState<{ top: number; left: number } | null>(null);

  const selected = datasets.find((item) => item.id === datasetId) ?? null;
  const kindLabel: Record<string, string> = {
    upload: messages.transform.kindUpload,
    database: messages.transform.kindDatabase,
    transform: messages.transform.kindTransform,
    api: messages.transform.kindApi,
  };
  const stepLabels: Record<StepOp, string> = {
    select: messages.transform.opSelect,
    drop: messages.transform.opDrop,
    rename: messages.transform.opRename,
    filter: messages.transform.opFilter,
    cast: messages.transform.opCast,
    fill_null: messages.transform.opFillNull,
    sort: messages.transform.opSort,
    unique: messages.transform.opUnique,
  };
  const stepHints: Record<StepOp, string> = {
    select: messages.transform.opSelectHint,
    drop: messages.transform.opDropHint,
    rename: messages.transform.opRenameHint,
    filter: messages.transform.opFilterHint,
    cast: messages.transform.opCastHint,
    fill_null: messages.transform.opFillNullHint,
    sort: messages.transform.opSortHint,
    unique: messages.transform.opUniqueHint,
  };

  async function refreshCatalog() {
    const datasetResponse = await datasetApi.list();
    setDatasets(datasetResponse.datasets);
  }

  useEffect(() => {
    void refreshCatalog().catch((err) =>
      toastError(messages.errors.workspace, err),
    );
  }, [messages]);

  useEffect(() => {
    if (!id) {
      setTransformId(undefined);
      return;
    }
    let cancelled = false;
    void transformApi
      .get(id)
      .then((row) => {
        if (cancelled) return;
        setTransformId(row.id);
        setDatasetId(row.dataset_id);
        setName(row.name);
        setSteps(Array.isArray(row.spec?.steps) ? row.spec.steps : []);
      })
      .catch((err) => {
        if (!cancelled) {
          toastError(messages.errors.workspace, err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, messages]);

  useEffect(() => {
    if (!detailOpen || !datasetId) return;
    const dataset = datasets.find((item) => item.id === datasetId) ?? null;
    const spec = specFrom(dataset, steps);
    let cancelled = false;
    setDetailLoading(true);
    void Promise.allSettled([
      datasetApi.inspect(datasetId, 200),
      datasetApi.preview(datasetId, spec, 200),
    ])
      .then(([inspected, previewed]) => {
        if (cancelled) return;
        if (inspected.status === "fulfilled") {
          setDatasets((current) =>
            current.map((item) =>
              item.id === inspected.value.dataset.id ? inspected.value.dataset : item,
            ),
          );
          setSourcePreview(inspected.value.preview);
        } else {
          toastError(messages.errors.inspect, inspected.reason);
        }
        if (previewed.status === "fulfilled") {
          setResultPreview(previewed.value);
        } else {
          setResultPreview(null);
          if (usableSteps(steps).length > 0) {
            toastError(messages.errors.previewTransform, previewed.reason);
          }
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [detailOpen, datasetId, detailTick, messages]);

  const grouped = useMemo(() => {
    return KIND_ORDER.map((kind) => ({
      kind,
      items: datasets.filter((item) => item.kind === kind),
    }));
  }, [datasets]);

  useEffect(() => {
    if (!addStepOpen) {
      setAddStepPos(null);
      return;
    }
    const box = addStepRef.current;
    if (box) {
      const rect = box.getBoundingClientRect();
      setAddStepPos({ top: rect.bottom + 6, left: rect.left });
    }
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (addStepRef.current?.contains(target) || addStepMenuRef.current?.contains(target)) {
        return;
      }
      setAddStepOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setAddStepOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [addStepOpen]);

  function buildSpec(): TransformSpecV2 {
    return specFrom(selected, steps);
  }

  function openDetail(tab: "source" | "result") {
    if (!datasetId) return;
    setDetailTab(tab);
    setDetailOpen(true);
    setDetailTick((tick) => tick + 1);
  }

  function onNew() {
    setTransformId(undefined);
    setDatasetId(undefined);
    setName("");
    setSteps([]);
    setSourcePreview(null);
    setResultPreview(null);
    navigate("/transform/clean");
  }

  async function onSave() {
    if (!datasetId) return;
    const title = name.trim() || selected?.filename || messages.transform.untitled;
    setBusy(true);
    try {
      if (transformId) {
        const row = await transformApi.update(transformId, {
          name: title,
          dataset_id: datasetId,
          spec: buildSpec(),
        });
        setName(row.name);
        await refreshCatalog();
      } else {
        const row = await transformApi.create({
          name: title,
          dataset_id: datasetId,
          spec: buildSpec(),
        });
        setTransformId(row.id);
        setName(row.name);
        await refreshCatalog();
        navigate(`/transform/clean/${row.id}`, { replace: true });
      }
    } catch (err) {
      toastError(messages.errors.saveTransform, err);
    } finally {
      setBusy(false);
    }
  }

  async function onRun() {
    setBusy(true);
    try {
      let savedId = transformId;
      const title = name.trim() || selected?.filename || messages.transform.untitled;
      if (!datasetId) return;
      if (savedId) {
        await transformApi.update(savedId, {
          name: title,
          dataset_id: datasetId,
          spec: buildSpec(),
        });
      } else {
        const row = await transformApi.create({
          name: title,
          dataset_id: datasetId,
          spec: buildSpec(),
        });
        savedId = row.id;
        setTransformId(row.id);
        navigate(`/transform/clean/${row.id}`, { replace: true });
      }
      const run = await transformApi.run(savedId);
      navigate(`/jobs/${run.id}`);
    } catch (err) {
      toastError(messages.errors.runJob, err);
    } finally {
      setBusy(false);
    }
  }

  function updateStep(index: number, next: TransformStep) {
    setSteps((current) => current.map((step, i) => (i === index ? next : step)));
  }

  const columns = selected?.columns ?? [];
  const activePreview = detailTab === "result" ? resultPreview : sourcePreview;
  const previewHeaders = activePreview?.columns.map((column) => column.name) ?? [];

  return (
    <PageShell>
      <PageHeader
        iconName="jobs"
        eyebrow={messages.transform.eyebrow}
        title={messages.transform.title}
        description={messages.transform.description}
        actions={
          <>
            <Button type="button" variant="quiet" className="gap-2" disabled={busy} onClick={onNew}>
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {messages.transform.reset}
            </Button>
            <Button
              type="button"
              className="gap-2"
              disabled={!datasetId || busy}
              onClick={() => openDetail(usableSteps(steps).length > 0 ? "result" : "source")}
            >
              <Eye className="size-3.5" aria-hidden="true" />
              {messages.transform.previewSteps}
            </Button>
            <Button type="button" className="gap-2" disabled={!datasetId || busy} onClick={() => void onSave()}>
              <BookmarkPlus className="size-3.5" aria-hidden="true" />
              {busy ? messages.common.saving : messages.transform.register}
            </Button>
            <Button
              variant="primary"
              type="button"
              className="gap-2"
              disabled={!datasetId || busy}
              onClick={() => void onRun()}
            >
              <FileDown className="size-3.5" aria-hidden="true" />
              {busy ? messages.transform.exporting : messages.transform.resultFile}
            </Button>
          </>
        }
      />

      <Panel tall>
        <SplitLayout
          className="min-h-0 flex-1"
          defaultSizes={[layout.split.catalog]}
        >
          <aside className="flex min-h-0 flex-col overflow-hidden">
            <PaneHeader
              title={messages.transform.catalog}
              meta={messages.common.count(datasets.length)}
            />
            <div className="min-h-0 flex-1 overflow-auto bg-surface">
              <div className="space-y-2 p-2">
                  {grouped.map((group) => {
                    const appearance = KIND_APPEARANCE[group.kind];
                    const KindIcon = appearance.icon;
                    const expanded = expandedKinds.has(group.kind);
                    const query = kindSearch[group.kind].trim().toLocaleLowerCase();
                    const visibleItems = query
                      ? group.items.filter((item) =>
                          item.filename.toLocaleLowerCase().includes(query),
                        )
                      : group.items;
                    return (
                      <section
                        key={group.kind}
                        className="overflow-hidden rounded-lg border border-border bg-surface"
                      >
                        <button
                          type="button"
                          aria-expanded={expanded}
                          className={cn(
                            "flex w-full items-center gap-2 px-3 py-2.5 text-left transition-[filter] hover:brightness-95",
                            expanded && "border-b",
                            appearance.header,
                          )}
                          onClick={() =>
                            setExpandedKinds((current) => {
                              const next = new Set(current);
                              if (expanded) next.delete(group.kind);
                              else next.add(group.kind);
                              return next;
                            })
                          }
                        >
                          <KindIcon className="size-4 shrink-0" aria-hidden="true" />
                          <span className="min-w-0 flex-1 text-sm font-bold">
                            {kindLabel[group.kind] ?? group.kind}
                          </span>
                          <span
                            className={cn(
                              "rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums",
                              appearance.count,
                            )}
                          >
                            {group.items.length}
                          </span>
                          <ChevronRight
                            className={cn(
                              "size-4 shrink-0 transition-transform",
                              expanded && "rotate-90",
                            )}
                            aria-hidden="true"
                          />
                        </button>
                        {expanded ? (
                          <div className="border-b border-border bg-raised p-2.5">
                            <div className="group flex h-9 items-center overflow-hidden rounded-lg border border-border bg-surface shadow-sm transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
                              <span className="grid h-full w-9 shrink-0 place-items-center border-r border-border bg-subtle text-text-tertiary transition-colors group-focus-within:text-accent">
                                <Search className="size-3.5" aria-hidden="true" />
                              </span>
                              <input
                                type="search"
                                className="min-w-0 flex-1 bg-transparent px-3 text-[13px] text-text outline-none placeholder:text-text-tertiary"
                                value={kindSearch[group.kind]}
                                placeholder={messages.transform.searchFiles}
                                aria-label={`${kindLabel[group.kind]} ${messages.transform.searchFiles}`}
                                onChange={(event) =>
                                  setKindSearch((current) => ({
                                    ...current,
                                    [group.kind]: event.target.value,
                                  }))
                                }
                              />
                            </div>
                          </div>
                        ) : null}
                        {expanded && visibleItems.length === 0 ? (
                          <p className="px-3 py-4 text-center text-xs text-text-tertiary">
                            {messages.transform.noMatchingFiles}
                          </p>
                        ) : null}
                        {expanded &&
                          visibleItems.map((item) => (
                            <button
                              key={item.id}
                              type="button"
                              className={cn(
                                "flex w-full min-w-0 items-start gap-2 border-b border-border px-3 py-2.5 text-left last:border-b-0",
                                selectableClass(item.id === datasetId),
                              )}
                              onClick={() => {
                                const selecting = datasetId !== item.id;
                                setDatasetId(selecting ? item.id : undefined);
                                if (selecting && !transformId) {
                                  setName((current) => current || item.filename);
                                }
                              }}
                            >
                              <FileSpreadsheet className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
                              <span className="min-w-0 flex-1">
                                <span className="block break-all text-[13px] font-medium leading-4">
                                  {item.filename}
                                </span>
                                <span className="mt-0.5 block truncate text-[11px] text-text-tertiary">
                                  {item.origin?.connection_name
                                    ? `${item.origin.connection_name} · ${item.origin.table_name}`
                                    : item.size_bytes != null
                                      ? fmtBytes(item.size_bytes)
                                      : item.id.slice(0, 8)}
                                </span>
                              </span>
                            </button>
                          ))}
                      </section>
                    );
                  })}
                </div>
            </div>
          </aside>

          <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            <PaneHeader
              title={messages.transform.setup}
              meta={messages.common.count(steps.length)}
              afterMeta={
                <div className="relative" ref={addStepRef}>
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-7 gap-1 px-2 text-[11px]"
                    disabled={!selected}
                    title={messages.transform.addStep}
                    aria-expanded={addStepOpen}
                    aria-haspopup="menu"
                    onClick={() => setAddStepOpen((open) => !open)}
                  >
                    <Plus className="size-3.5 shrink-0" aria-hidden="true" />
                    {messages.transform.addStep}
                  </Button>
                  {addStepOpen && addStepPos
                    ? createPortal(
                        <div
                          ref={addStepMenuRef}
                          role="menu"
                          className="fixed z-[220] w-72 overflow-y-auto rounded-xl border border-border bg-surface py-1 shadow-[0_10px_28px_rgba(15,23,42,0.14)] dark:shadow-[0_14px_32px_rgba(0,0,0,0.48)]"
                          style={{ top: addStepPos.top, left: addStepPos.left, maxHeight: 320 }}
                        >
                          {STEP_OPS.map((op) => (
                            <button
                              key={op}
                              type="button"
                              role="menuitem"
                              className="flex w-full flex-col px-3 py-2 text-left hover:bg-accent-subtle"
                              onClick={() => {
                                setSteps((current) => [...current, emptyStep(op)]);
                                setAddStepOpen(false);
                              }}
                            >
                              <span className="text-[13px] font-semibold text-text">
                                {stepLabels[op]}
                              </span>
                              <span className="mt-0.5 text-[11px] leading-4 text-text-tertiary">
                                {stepHints[op]}
                              </span>
                            </button>
                          ))}
                        </div>,
                        document.body,
                      )
                    : null}
                </div>
              }
            />
            {!selected ? (
              <div className="flex min-h-0 flex-1 items-center justify-center px-4">
                <p className="text-sm text-text-tertiary">{messages.transform.pickFile}</p>
              </div>
            ) : (
              <>
                <div className="grid items-stretch gap-4 border-b border-border px-4 py-3 md:grid-cols-2">
                  <FormField label={messages.transform.namePlaceholder}>
                    <div className="flex h-[3.25rem] items-start gap-2 rounded border border-border bg-surface px-2.5 py-1.5 text-[13px] focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
                      <FileSpreadsheet className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
                      <textarea
                        rows={2}
                        className="h-[2.5rem] min-w-0 flex-1 resize-none overflow-x-auto overflow-y-auto bg-transparent leading-5 text-text outline-none placeholder:text-text-tertiary"
                        value={name}
                        placeholder={messages.transform.namePlaceholder}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </div>
                  </FormField>
                  <FormField label={messages.transform.selectedFile}>
                    <div className="flex h-[3.25rem] items-start gap-2 rounded border border-border bg-raised px-2.5 py-1.5 text-[13px]">
                      <FileSpreadsheet className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
                      <span
                        title={selected.filename}
                        className="line-clamp-2 h-[2.5rem] min-w-0 flex-1 overflow-hidden break-all leading-5"
                      >
                        {selected.filename}
                      </span>
                    </div>
                  </FormField>
                </div>
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="min-h-0 flex-1 overflow-auto">
                    {steps.length === 0 ? (
                      <div className="grid h-full min-h-32 place-items-center px-4">
                        <p className="text-sm text-text-tertiary">{messages.empty.steps}</p>
                      </div>
                    ) : (
                      steps.map((step, index) => (
                        <article key={`${step.op}-${index}`} className="border-b border-border p-3">
                          <div className="mb-2 flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <span className="text-xs font-semibold uppercase tracking-[0.06em]">
                                {index + 1}. {stepLabels[step.op]}
                              </span>
                              <p className="mt-1 text-[11px] leading-4 text-text-tertiary">
                                {stepHints[step.op]}
                              </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <Button
                                type="button"
                                variant="quiet"
                                disabled={index === 0}
                                onClick={() =>
                                  setSteps((current) => {
                                    const next = [...current];
                                    [next[index - 1], next[index]] = [next[index], next[index - 1]];
                                    return next;
                                  })
                                }
                              >
                                ↑
                              </Button>
                              <Button
                                type="button"
                                variant="quiet"
                                disabled={index === steps.length - 1}
                                onClick={() =>
                                  setSteps((current) => {
                                    const next = [...current];
                                    [next[index], next[index + 1]] = [next[index + 1], next[index]];
                                    return next;
                                  })
                                }
                              >
                                ↓
                              </Button>
                              <Button
                                type="button"
                                variant="quiet"
                                onClick={() =>
                                  setSteps((current) => current.filter((_, i) => i !== index))
                                }
                              >
                                <Trash2 className="size-3.5" aria-hidden="true" />
                              </Button>
                            </div>
                          </div>
                          <StepFields
                            step={step}
                            columns={columns}
                            onChange={(next) => updateStep(index, next)}
                            messages={messages}
                          />
                        </article>
                      ))
                    )}
                  </div>
                  <p className="shrink-0 border-t border-border px-4 py-2.5 text-[11px] leading-4 text-text-tertiary">
                    {messages.transform.registerHint}
                  </p>
                </div>
              </>
            )}
          </section>
        </SplitLayout>
      </Panel>

      <AppDialog
        open={detailOpen}
        title={selected?.filename ?? messages.transform.previewSteps}
        icon={<FileSpreadsheet className="size-4 text-accent" aria-hidden="true" />}
        className="h-[min(42rem,88vh)] w-[min(72rem,94vw)]"
        minWidth={520}
        minHeight={360}
        onClose={() => setDetailOpen(false)}
        headerExtra={
          <div className="flex gap-1">
            <Button
              type="button"
              variant={detailTab === "source" ? "secondary" : "quiet"}
              onClick={() => setDetailTab("source")}
            >
              {messages.transform.inspect}
            </Button>
            <Button
              type="button"
              variant={detailTab === "result" ? "secondary" : "quiet"}
              onClick={() => setDetailTab("result")}
            >
              {messages.transform.resultPreview}
            </Button>
          </div>
        }
        footer={
          <Button type="button" variant="secondary" onClick={() => setDetailOpen(false)}>
            {messages.common.close}
          </Button>
        }
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {activePreview ? (
            <div className="flex min-w-0 shrink-0 flex-wrap items-start gap-5 border-b border-border px-4 py-2.5">
              <MetaField label={messages.files.previewRows} technical>
                {messages.common.rows(activePreview.sampled_rows)}
              </MetaField>
              {activePreview.row_count != null ? (
                <MetaField label={messages.files.totalRows} technical>
                  {messages.common.rows(activePreview.row_count)}
                </MetaField>
              ) : null}
              {previewHeaders.length > 0 ? (
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-medium leading-none text-text-tertiary">
                    {messages.common.columns}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {activePreview.columns.map((column) => (
                      <span
                        key={column.name}
                        title={`${column.name} ${column.dtype}`}
                        className="max-w-full truncate rounded-full border border-border bg-raised px-2 py-0.5 text-[11px] font-medium text-text"
                      >
                        {column.name}
                        <span className="ml-1 text-text-tertiary">{column.dtype}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden p-4">
            {detailLoading ? (
              <div className="grid h-full min-h-64 place-items-center text-sm text-text-tertiary">
                {messages.common.loading}
              </div>
            ) : (
              <PreviewGrid
                preview={activePreview}
                empty={
                  detailTab === "result"
                    ? messages.transform.previewHint
                    : messages.empty.preview
                }
              />
            )}
          </div>
        </div>
      </AppDialog>
    </PageShell>
  );
}

function StepFields({
  step,
  columns,
  onChange,
  messages,
}: {
  step: TransformStep;
  columns: DatasetColumn[];
  onChange: (step: TransformStep) => void;
  messages: ReturnType<typeof useLanguage>["messages"];
}) {
  const names = columns.map((column) => column.name).join(", ");
  switch (step.op) {
    case "select":
    case "drop":
      return (
        <input
          className="field-control technical"
          value={step.columns.join(", ")}
          placeholder={names || "id, amount"}
          onChange={(event) => onChange({ ...step, columns: parseList(event.target.value) })}
        />
      );
    case "rename":
      return (
        <input
          className="field-control technical"
          value={formatRename(step.map)}
          placeholder="amount:amt, id:user_id"
          onChange={(event) => onChange({ ...step, map: parseRename(event.target.value) })}
        />
      );
    case "filter":
      return (
        <input
          className="field-control technical"
          value={step.expr}
          placeholder="amount > 0"
          onChange={(event) => onChange({ ...step, expr: event.target.value })}
        />
      );
    case "cast":
      return (
        <input
          className="field-control technical"
          value={formatCast(step.columns)}
          placeholder={`id:Int64 · ${CAST_TYPES.join(", ")}`}
          onChange={(event) => onChange({ ...step, columns: parseCast(event.target.value) })}
        />
      );
    case "fill_null":
      return (
        <div className="grid gap-2">
          <input
            className="field-control technical"
            value={step.columns.join(", ")}
            placeholder={names || "amount"}
            onChange={(event) => onChange({ ...step, columns: parseList(event.target.value) })}
          />
          <input
            className="field-control technical"
            value={step.value}
            placeholder={messages.transform.fillValue}
            onChange={(event) => onChange({ ...step, value: event.target.value })}
          />
        </div>
      );
    case "sort":
      return (
        <div className="grid gap-2">
          {step.by.map((item, index) => (
            <div key={index} className="flex gap-2">
              <input
                className="field-control technical min-w-0 flex-1"
                value={item.column}
                placeholder={names || "id"}
                onChange={(event) => {
                  const by = step.by.map((row, i) =>
                    i === index ? { ...row, column: event.target.value } : row,
                  );
                  onChange({ ...step, by });
                }}
              />
              <label className="flex items-center gap-1 text-xs text-text-secondary">
                <input
                  type="checkbox"
                  checked={item.descending}
                  onChange={(event) => {
                    const by = step.by.map((row, i) =>
                      i === index ? { ...row, descending: event.target.checked } : row,
                    );
                    onChange({ ...step, by });
                  }}
                />
                {messages.transform.descending}
              </label>
            </div>
          ))}
        </div>
      );
    case "unique":
      return (
        <div className="grid gap-2">
          <input
            className="field-control technical"
            value={(step.subset ?? []).join(", ")}
            placeholder={messages.transform.uniqueSubset}
            onChange={(event) => onChange({ ...step, subset: parseList(event.target.value) })}
          />
          <Select
            value={step.keep ?? "first"}
            options={[
              { value: "first", label: messages.transform.keepFirst },
              { value: "last", label: messages.transform.keepLast },
              { value: "any", label: messages.transform.keepAny },
              { value: "none", label: messages.transform.keepNone },
            ]}
            onChange={(value) =>
              onChange({
                ...step,
                keep: value as "first" | "last" | "none" | "any",
              })
            }
          />
        </div>
      );
  }
}
