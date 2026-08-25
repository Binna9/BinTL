import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Braces,
  ChevronRight,
  Database,
  FileOutput,
  Play,
  Plus,
  Save,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { PageHeader, PageShell } from "@/components/PageShell";
import { SplitLayout } from "@/components/SplitLayout";
import { Button } from "@/components/ui/button";
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
  SavedTransform,
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
const KIND_ORDER = ["upload", "database", "transform", "api"] as const;
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
  const headers = ["#", ...preview.columns.map((column) => column.name)];
  return (
    <DataGrid headers={headers}>
      {preview.rows.length === 0 ? (
        <EmptyGridRow cols={headers.length} text={empty} />
      ) : (
        preview.rows.map((row, index) => (
          <GridRow key={index}>
            <GridCell mono muted>
              {index + 1}
            </GridCell>
            {row.map((cell, cellIndex) => (
              <GridCell key={cellIndex} mono>
                {cell}
              </GridCell>
            ))}
          </GridRow>
        ))
      )}
    </DataGrid>
  );
}

function SchemaChips({ columns }: { columns: DatasetColumn[] }) {
  if (columns.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-3 py-2">
      {columns.map((column) => (
        <span
          key={column.name}
          className="rounded-full border border-border bg-raised px-2 py-0.5 text-[11px] text-text"
        >
          <span className="font-medium">{column.name}</span>
          <span className="ml-1 text-text-tertiary">{column.dtype}</span>
        </span>
      ))}
    </div>
  );
}

export function TransformPage() {
  const { messages } = useLanguage();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [transforms, setTransforms] = useState<SavedTransform[]>([]);
  const [datasetId, setDatasetId] = useState<string>();
  const [transformId, setTransformId] = useState<string>();
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<TransformStep[]>([]);
  const [sourcePreview, setSourcePreview] = useState<FramePreview | null>(null);
  const [resultPreview, setResultPreview] = useState<FramePreview | null>(null);
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

  const selected = datasets.find((item) => item.id === datasetId) ?? null;
  const kindLabel: Record<string, string> = {
    upload: messages.transform.kindUpload,
    database: messages.transform.kindDatabase,
    transform: messages.transform.kindTransform,
    api: messages.transform.kindApi,
  };

  async function refreshCatalog() {
    const [datasetResponse, transformResponse] = await Promise.all([
      datasetApi.list(),
      transformApi.list(),
    ]);
    setDatasets(datasetResponse.datasets);
    setTransforms(transformResponse.transforms);
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
    if (!datasetId) {
      setSourcePreview(null);
      setResultPreview(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    void datasetApi
      .inspect(datasetId, 50)
      .then((result) => {
        if (cancelled) return;
        setDatasets((current) =>
          current.map((item) => (item.id === result.dataset.id ? result.dataset : item)),
        );
        setSourcePreview(result.preview);
      })
      .catch((err) => {
        if (!cancelled) {
          toastError(messages.errors.inspect, err);
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [datasetId, messages]);

  const grouped = useMemo(() => {
    return KIND_ORDER.map((kind) => ({
      kind,
      items: datasets.filter((item) => item.kind === kind),
    })).filter((group) => group.items.length > 0);
  }, [datasets]);

  function buildSpec(): TransformSpecV2 {
    return specFrom(selected, steps);
  }

  async function onPreview() {
    if (!datasetId) return;
    setBusy(true);
    try {
      const preview = await datasetApi.preview(datasetId, buildSpec(), 50);
      setResultPreview(preview);
    } catch (err) {
      toastError(messages.errors.previewTransform, err);
    } finally {
      setBusy(false);
    }
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
        navigate(`/transform/${row.id}`, { replace: true });
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
        navigate(`/transform/${row.id}`, { replace: true });
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

  return (
    <PageShell>
      <PageHeader
        iconName="jobs"
        eyebrow={messages.transform.eyebrow}
        title={messages.transform.title}
        description={messages.transform.description}
        actions={
          <>
            <Button type="button" className="gap-2" disabled={!datasetId || busy} onClick={() => void onPreview()}>
              {messages.transform.previewSteps}
            </Button>
            <Button type="button" className="gap-2" disabled={!datasetId || busy} onClick={() => void onSave()}>
              <Save className="size-3.5" aria-hidden="true" />
              {busy ? messages.common.saving : messages.common.save}
            </Button>
            <Button
              variant="primary"
              type="button"
              className="gap-2"
              disabled={!datasetId || busy}
              onClick={() => void onRun()}
            >
              <Play className="size-3.5 fill-current" aria-hidden="true" />
              {busy ? messages.common.running : messages.common.run}
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
              title={messages.transform.saved}
              meta={messages.common.count(transforms.length)}
            />
            <div className="max-h-40 overflow-auto border-b border-border bg-surface">
              {transforms.length === 0 ? (
                <p className="p-3 text-xs text-text-tertiary">{messages.empty.transforms}</p>
              ) : (
                transforms.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={cn(
                      "block w-full min-w-0 overflow-hidden border-b border-border px-3 py-2 text-left last:border-b-0",
                      selectableClass(item.id === transformId),
                    )}
                    onClick={() => navigate(`/transform/${item.id}`)}
                  >
                    <span className="block truncate text-[13px]">{item.name}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-text-tertiary">
                      {item.dataset_id.slice(0, 8)}
                    </span>
                  </button>
                ))
              )}
            </div>
            <PaneHeader
              title={messages.transform.catalog}
              meta={messages.common.count(datasets.length)}
            />
            <div className="min-h-0 flex-1 overflow-auto bg-surface">
              {grouped.length === 0 ? (
                <p className="p-3 text-xs text-text-tertiary">{messages.empty.datasets}</p>
              ) : (
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
                                "block w-full min-w-0 overflow-hidden border-b border-border px-3 py-2.5 text-left last:border-b-0",
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
                              <span className="block truncate text-[13px] font-medium">
                                {item.filename}
                              </span>
                              <span className="mt-0.5 block truncate text-[11px] text-text-tertiary">
                                {item.origin?.connection_name
                                  ? `${item.origin.connection_name} · ${item.origin.table_name}`
                                  : item.size_bytes != null
                                    ? fmtBytes(item.size_bytes)
                                    : item.id.slice(0, 8)}
                              </span>
                            </button>
                          ))}
                      </section>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>

          <SplitLayout fill={false} className="min-h-0" defaultSizes={[layout.split.inspect]}>
            <section className="flex min-h-0 flex-col overflow-hidden">
              <PaneHeader
                title={messages.transform.inspect}
                description={selected?.filename}
                meta={
                  sourcePreview?.row_count != null
                    ? messages.common.rows(sourcePreview.row_count)
                    : undefined
                }
              />
              {!selected ? (
                <p className="p-4 text-sm text-text-secondary">{messages.transform.pickFile}</p>
              ) : (
                <>
                  <SchemaChips
                    columns={
                      sourcePreview?.columns?.length
                        ? sourcePreview.columns
                        : selected.columns
                    }
                  />
                  <div className="min-h-0 flex-1 overflow-auto">
                    <PreviewGrid preview={sourcePreview} empty={messages.empty.preview} />
                  </div>
                </>
              )}
            </section>

            <section className="flex min-h-0 flex-col overflow-hidden">
              <PaneHeader
                title={messages.transform.steps}
                meta={messages.common.count(steps.length)}
                actions={
                  <Select
                    placeholder={messages.transform.addStep}
                    options={STEP_OPS.map((op) => ({ value: op, label: stepLabels[op] }))}
                    value=""
                    onChange={(value) => {
                      if (!value) return;
                      setSteps((current) => [...current, emptyStep(value as StepOp)]);
                    }}
                  />
                }
              />
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <input
                  className="field-control min-w-0 flex-1"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={messages.transform.namePlaceholder}
                />
              </div>
              <div className="min-h-0 flex-1 overflow-auto bg-surface">
                {steps.length === 0 ? (
                  <p className="p-3 text-xs text-text-tertiary">{messages.empty.steps}</p>
                ) : (
                  steps.map((step, index) => (
                    <article key={`${step.op}-${index}`} className="border-b border-border p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold uppercase tracking-[0.06em]">
                          {index + 1}. {stepLabels[step.op]}
                        </span>
                        <div className="flex items-center gap-1">
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
                        columns={sourcePreview?.columns ?? selected?.columns ?? []}
                        onChange={(next) => updateStep(index, next)}
                        messages={messages}
                      />
                    </article>
                  ))
                )}
              </div>
              <PaneHeader
                title={messages.transform.resultPreview}
                meta={
                  resultPreview
                    ? messages.common.rows(resultPreview.sampled_rows)
                    : undefined
                }
                actions={
                  <Button type="button" variant="quiet" disabled={!datasetId || busy} onClick={() => void onPreview()}>
                    <Plus className="size-3.5" aria-hidden="true" />
                    {messages.transform.previewSteps}
                  </Button>
                }
              />
              <div className="min-h-40 overflow-auto">
                <PreviewGrid preview={resultPreview} empty={messages.transform.previewHint} />
              </div>
            </section>
          </SplitLayout>
        </SplitLayout>
      </Panel>
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
