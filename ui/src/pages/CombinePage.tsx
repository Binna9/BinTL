import { useEffect, useMemo, useState } from "react";
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
  GitMerge,
  Layers,
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
import { showConfirm, toastDeleteError, toastError, toastSuccess } from "@/lib/notifications";
import { HttpError } from "@/services/httpClient";
import { selectableClass } from "@/lib/selectable";
import { chipApi } from "@/services/chipApi";
import { datasetApi } from "@/services/datasetApi";
import { transformApi } from "@/services/transformApi";
import type { Dataset, DatasetColumn, FramePreview } from "@/types/dataset";
import type { CombineSpec, TransformSpecV2 } from "@/types/transform";

type CombineMode = CombineSpec["mode"];

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

function ColumnChipPicker({
  columns,
  value,
  emptyLabel,
  onChange,
  minSelected = 1,
}: {
  columns: DatasetColumn[];
  value: string[];
  emptyLabel: string;
  onChange: (columns: string[]) => void;
  minSelected?: number;
}) {
  if (columns.length === 0) {
    return <p className="text-xs text-text-tertiary">{emptyLabel}</p>;
  }
  const kept = new Set(value);
  function toggle(name: string) {
    if (kept.has(name)) {
      if (kept.size <= minSelected) return;
      onChange(value.filter((column) => column !== name));
      return;
    }
    onChange([...value, name]);
  }
  return (
    <div className="scroll-pane -mx-0.5 overflow-x-auto px-0.5">
      <div className="flex flex-nowrap gap-1.5 pb-0.5">
        {columns.map((column) => {
          const active = kept.has(column.name);
          return (
            <button
              key={column.name}
              type="button"
              aria-pressed={active}
              onClick={() => toggle(column.name)}
              className={cn(
                "shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                active
                  ? "border-accent bg-accent-subtle text-accent"
                  : "border-border bg-raised text-text-tertiary hover:border-border hover:bg-subtle hover:text-text-secondary",
              )}
            >
              {column.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PreviewGrid({ preview, empty }: { preview: FramePreview | null; empty: string }) {
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

export function CombinePage() {
  const { messages } = useLanguage();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const t = messages.transform;

  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [datasetId, setDatasetId] = useState<string>();
  const [transformId, setTransformId] = useState<string>();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<CombineMode>("join");
  const [rightDatasetId, setRightDatasetId] = useState<string>();
  const [unionDatasetIds, setUnionDatasetIds] = useState<string[]>([]);
  const [joinKeys, setJoinKeys] = useState<string[]>([]);
  const [joinHow, setJoinHow] = useState<"left" | "inner">("left");
  const [sourcePreview, setSourcePreview] = useState<FramePreview | null>(null);
  const [rightPreview, setRightPreview] = useState<FramePreview | null>(null);
  const [resultPreview, setResultPreview] = useState<FramePreview | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<"source" | "result">("source");
  const [detailTick, setDetailTick] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [expandedKinds, setExpandedKinds] = useState<Set<(typeof KIND_ORDER)[number]>>(
    new Set(KIND_ORDER),
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
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registerChipName, setRegisterChipName] = useState("");
  const [registerBusy, setRegisterBusy] = useState(false);
  const [linkedTransformId, setLinkedTransformId] = useState<string>();
  const [sourceMissing, setSourceMissing] = useState(false);

  const selected = datasets.find((item) => item.id === datasetId) ?? null;
  const rightSelected = datasets.find((item) => item.id === rightDatasetId) ?? null;
  const savedTransformId = transformId ?? linkedTransformId;

  const kindLabel: Record<string, string> = {
    upload: t.kindUpload,
    database: t.kindDatabase,
    transform: t.kindTransform,
    api: t.kindApi,
  };

  const leftColumns =
    sourcePreview && sourcePreview.columns.length > 0
      ? sourcePreview.columns
      : (selected?.columns ?? []);
  const rightColumns =
    rightPreview && rightPreview.columns.length > 0
      ? rightPreview.columns
      : (rightSelected?.columns ?? []);

  const commonJoinKeys = useMemo(() => {
    const rightNames = new Set(rightColumns.map((column) => column.name));
    return leftColumns.filter((column) => rightNames.has(column.name));
  }, [leftColumns, rightColumns]);

  const canPreview =
    mode === "join"
      ? Boolean(datasetId && rightDatasetId && joinKeys.length > 0)
      : Boolean(datasetId && unionDatasetIds.length > 0);

  const grouped = useMemo(
    () =>
      KIND_ORDER.map((kind) => ({
        kind,
        items: datasets.filter((item) => item.kind === kind),
      })),
    [datasets],
  );

  async function refreshCatalog() {
    const datasetResponse = await datasetApi.list();
    setDatasets(datasetResponse.datasets);
  }

  function buildSpec(): TransformSpecV2 {
    const combine: CombineSpec =
      mode === "join"
        ? {
            mode: "join",
            right_dataset_id: rightDatasetId,
            on: joinKeys,
            how: joinHow,
          }
        : {
            mode: "union",
            union_dataset_ids: unionDatasetIds,
          };
    return { version: 2, sink: "parquet", steps: [], combine };
  }

  useEffect(() => {
    void refreshCatalog().catch((err) => toastError(messages.errors.workspace, err));
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
        const combine = row.spec?.combine;
        if (!combine) return;
        setTransformId(row.id);
        setDatasetId(row.dataset_id);
        setName(row.name);
        setMode(combine.mode);
        if (combine.mode === "join") {
          setRightDatasetId(combine.right_dataset_id);
          setJoinKeys(combine.on ?? []);
          setJoinHow(combine.how ?? "left");
          setUnionDatasetIds([]);
        } else {
          setUnionDatasetIds(combine.union_dataset_ids ?? []);
          setRightDatasetId(undefined);
          setJoinKeys([]);
        }
      })
      .catch((err) => {
        if (!cancelled) toastError(messages.errors.workspace, err);
      });
    return () => {
      cancelled = true;
    };
  }, [id, messages]);

  useEffect(() => {
    if (!datasetId) {
      setSourcePreview(null);
      setSourceMissing(false);
      return;
    }
    if (selected && !selected.available) {
      setSourcePreview(null);
      setSourceMissing(true);
      return;
    }
    setSourceMissing(false);
    let cancelled = false;
    void datasetApi
      .inspect(datasetId, 100)
      .then((inspected) => {
        if (cancelled) return;
        setDatasets((current) =>
          current.map((item) => (item.id === inspected.dataset.id ? inspected.dataset : item)),
        );
        setSourcePreview(inspected.preview);
      })
      .catch((err) => {
        if (cancelled) return;
        setSourcePreview(null);
        if (err instanceof HttpError && err.status === 404) {
          setSourceMissing(true);
          return;
        }
        toastError(messages.errors.inspect, err);
      });
    return () => {
      cancelled = true;
    };
  }, [datasetId, selected?.available, messages]);

  useEffect(() => {
    if (!rightDatasetId || mode !== "join") {
      setRightPreview(null);
      return;
    }
    let cancelled = false;
    void datasetApi
      .inspect(rightDatasetId, 100)
      .then((inspected) => {
        if (cancelled) return;
        setRightPreview(inspected.preview);
      })
      .catch((err) => {
        if (cancelled) return;
        setRightPreview(null);
        toastError(messages.errors.inspect, err);
      });
    return () => {
      cancelled = true;
    };
  }, [rightDatasetId, mode, messages]);

  useEffect(() => {
    if (!datasetId || transformId) {
      setLinkedTransformId(undefined);
      return;
    }
    let cancelled = false;
    void transformApi
      .list()
      .then((response) => {
        if (cancelled) return;
        const linked = response.transforms.find(
          (row) => row.dataset_id === datasetId && row.spec?.combine,
        );
        setLinkedTransformId(linked?.id);
      })
      .catch(() => {
        if (!cancelled) setLinkedTransformId(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [datasetId, transformId]);

  useEffect(() => {
    if (joinKeys.length === 0 && commonJoinKeys.length > 0) {
      setJoinKeys([commonJoinKeys[0]!.name]);
    }
  }, [commonJoinKeys, joinKeys.length]);

  useEffect(() => {
    if (!detailOpen || !datasetId) return;
    const spec = buildSpec();
    let cancelled = false;
    setDetailLoading(true);
    void Promise.allSettled([
      datasetApi.inspect(datasetId, 200),
      canPreview ? datasetApi.preview(datasetId, spec, 200) : Promise.resolve(null),
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
        } else if (canPreview) {
          setResultPreview(null);
          toastError(messages.errors.previewTransform, previewed.reason);
        } else {
          setResultPreview(null);
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [detailOpen, datasetId, detailTick, messages, canPreview, mode, rightDatasetId, unionDatasetIds, joinKeys, joinHow]);

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
    setMode("join");
    setRightDatasetId(undefined);
    setUnionDatasetIds([]);
    setJoinKeys([]);
    setJoinHow("left");
    setSourcePreview(null);
    setRightPreview(null);
    setResultPreview(null);
    navigate("/transform/combine");
  }

  function openRegister() {
    setRegisterChipName(name.trim() || selected?.filename || t.untitled);
    setRegisterOpen(true);
  }

  async function onRegisterChip() {
    if (!datasetId || !registerChipName.trim() || !canPreview) return;
    setRegisterBusy(true);
    try {
      const title = name.trim() || selected?.filename || t.untitled;
      let savedTransformId = transformId;
      if (savedTransformId) {
        await transformApi.update(savedTransformId, {
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
        savedTransformId = row.id;
        setTransformId(row.id);
        setName(row.name);
        navigate(`/transform/combine/${row.id}`, { replace: true });
      }
      await chipApi.register({
        name: registerChipName.trim(),
        kind: "transform",
        transform_id: savedTransformId,
      });
      setRegisterOpen(false);
      toastSuccess(messages.query.taskRegistered);
    } catch (err) {
      toastError(messages.errors.saveTransform, err);
    } finally {
      setRegisterBusy(false);
    }
  }

  async function onDeleteSaved() {
    if (!savedTransformId) return;
    const title = name.trim() || selected?.filename || t.untitled;
    const confirmed = await showConfirm(
      t.deleteSavedRecipe,
      t.deleteSavedRecipeConfirm(title),
      { tone: "danger", confirmLabel: messages.common.delete },
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await transformApi.delete(savedTransformId);
      toastSuccess(t.deleteSavedRecipeDone);
      setLinkedTransformId(undefined);
      if (transformId) onNew();
    } catch (err) {
      toastDeleteError(messages.errors.deleteTransform, messages.errors.deleteBlocked, err);
    } finally {
      setBusy(false);
    }
  }

  async function onRun() {
    if (!datasetId || !canPreview) return;
    setBusy(true);
    try {
      const title = name.trim() || selected?.filename || t.untitled;
      let savedId = transformId;
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
        navigate(`/transform/combine/${row.id}`, { replace: true });
      }
      const run = await transformApi.run(savedId);
      navigate(`/jobs/${run.id}`);
    } catch (err) {
      toastError(messages.errors.runJob, err);
    } finally {
      setBusy(false);
    }
  }

  function toggleUnion(id: string) {
    setUnionDatasetIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  const activePreview = detailTab === "result" ? resultPreview : sourcePreview;
  const previewHeaders = activePreview?.columns.map((column) => column.name) ?? [];
  const combineModeLabel = mode === "join" ? t.combineModeJoin : t.combineModeUnion;

  return (
    <PageShell>
      <PageHeader
        iconName="jobs"
        eyebrow={t.eyebrow}
        title={t.combineTitle}
        description={t.combineDescription}
        actions={
          <>
            <Button type="button" variant="quiet" className="gap-2" disabled={busy} onClick={onNew}>
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {t.reset}
            </Button>
            {savedTransformId ? (
              <Button
                type="button"
                variant="quiet"
                className="gap-2"
                disabled={busy}
                onClick={() => void onDeleteSaved()}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                {t.deleteSavedRecipe}
              </Button>
            ) : null}
            <Button
              type="button"
              className="gap-2"
              disabled={!datasetId || busy}
              onClick={() => openDetail(canPreview ? "result" : "source")}
            >
              <Eye className="size-3.5" aria-hidden="true" />
              {t.previewSteps}
            </Button>
            <Button
              type="button"
              className="gap-2"
              disabled={!datasetId || !canPreview || busy}
              onClick={openRegister}
            >
              <BookmarkPlus className="size-3.5" aria-hidden="true" />
              {busy ? messages.common.saving : t.register}
            </Button>
            <Button
              variant="primary"
              type="button"
              className="gap-2"
              disabled={!datasetId || !canPreview || busy}
              onClick={() => void onRun()}
            >
              <FileDown className="size-3.5" aria-hidden="true" />
              {busy ? t.exporting : t.resultFile}
            </Button>
          </>
        }
      />

      <Panel tall>
        <SplitLayout className="min-h-0 flex-1" defaultSizes={[layout.split.catalog]}>
          <aside className="flex min-h-0 flex-col overflow-hidden">
            <PaneHeader title={t.catalog} meta={messages.common.count(datasets.length)} />
            <div className="scroll-pane min-h-0 flex-1 overflow-auto bg-surface">
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
                              placeholder={t.searchFiles}
                              aria-label={`${kindLabel[group.kind]} ${t.searchFiles}`}
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
                          {t.noMatchingFiles}
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
                            <FileSpreadsheet
                              className="mt-0.5 size-3.5 shrink-0 text-text-tertiary"
                              aria-hidden="true"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block break-all text-[13px] font-medium leading-4">
                                {item.filename}
                                {!item.available ? (
                                  <span className="ml-1 text-[11px] font-normal text-warning">
                                    ({t.sourceUnavailable})
                                  </span>
                                ) : null}
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
            <PaneHeader title={t.setup} meta={combineModeLabel} />
            {!selected ? (
              <div className="flex min-h-0 flex-1 items-center justify-center px-4">
                <p className="text-sm text-text-tertiary">{t.pickFile}</p>
              </div>
            ) : (
              <>
                <div className="grid items-stretch gap-4 border-b border-border px-4 py-3 md:grid-cols-2">
                  <FormField label={t.namePlaceholder}>
                    <div className="flex h-[3.25rem] items-start gap-2 rounded border border-border bg-surface px-2.5 py-1.5 text-[13px] focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
                      <FileSpreadsheet
                        className="mt-0.5 size-3.5 shrink-0 text-text-tertiary"
                        aria-hidden="true"
                      />
                      <textarea
                        rows={2}
                        className="h-[2.5rem] min-w-0 flex-1 resize-none overflow-x-auto overflow-y-auto bg-transparent leading-5 text-text outline-none placeholder:text-text-tertiary"
                        value={name}
                        placeholder={t.namePlaceholder}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </div>
                  </FormField>
                  <FormField label={t.selectedFile}>
                    <div className="flex h-[3.25rem] items-start gap-2 rounded border border-border bg-raised px-2.5 py-1.5 text-[13px]">
                      <FileSpreadsheet
                        className="mt-0.5 size-3.5 shrink-0 text-text-tertiary"
                        aria-hidden="true"
                      />
                      <span
                        title={selected.filename}
                        className="line-clamp-2 h-[2.5rem] min-w-0 flex-1 overflow-hidden break-all leading-5"
                      >
                        {selected.filename}
                      </span>
                    </div>
                  </FormField>
                </div>
                {sourceMissing ? (
                  <p className="border-b border-border px-4 py-2.5 text-[11px] leading-5 text-warning">
                    {t.sourceFileMissing}
                  </p>
                ) : null}
                <div className="scroll-pane min-h-0 flex-1 overflow-auto p-4">
                  <div className="flex flex-col gap-5">
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant={mode === "join" ? "primary" : "quiet"}
                        className="gap-2"
                        onClick={() => setMode("join")}
                      >
                        <GitMerge className="size-3.5" aria-hidden="true" />
                        {t.combineModeJoin}
                      </Button>
                      <Button
                        type="button"
                        variant={mode === "union" ? "primary" : "quiet"}
                        className="gap-2"
                        onClick={() => setMode("union")}
                      >
                        <Layers className="size-3.5" aria-hidden="true" />
                        {t.combineModeUnion}
                      </Button>
                    </div>

                    {mode === "join" ? (
                      <>
                        <FormField label={t.combineRight}>
                          <Select
                            value={rightDatasetId ?? ""}
                            placeholder={t.combinePickRight}
                            options={datasets
                              .filter((item) => item.id !== datasetId && item.available)
                              .map((item) => ({ value: item.id, label: item.filename }))}
                            onChange={(value) => setRightDatasetId(value || undefined)}
                          />
                        </FormField>
                        <FormField label={t.combineJoinKeys} hint={t.combineJoinKeysHint}>
                          <ColumnChipPicker
                            columns={commonJoinKeys}
                            value={joinKeys}
                            emptyLabel={t.combineNoCommonKeys}
                            onChange={setJoinKeys}
                          />
                        </FormField>
                        <FormField label={t.combineJoinHow}>
                          <Select
                            value={joinHow}
                            options={[
                              { value: "left", label: t.combineJoinLeft },
                              { value: "inner", label: t.combineJoinInner },
                            ]}
                            onChange={(value) => setJoinHow(value as "left" | "inner")}
                          />
                        </FormField>
                      </>
                    ) : (
                      <FormField label={t.combineUnionExtra} hint={t.combineUnionHint}>
                        <div className="space-y-1">
                          {datasets
                            .filter((item) => item.id !== datasetId && item.available)
                            .map((item) => {
                              const active = unionDatasetIds.includes(item.id);
                              return (
                                <button
                                  key={item.id}
                                  type="button"
                                  aria-pressed={active}
                                  onClick={() => toggleUnion(item.id)}
                                  className={cn(
                                    "flex w-full min-w-0 items-start gap-2 border-b border-border px-3 py-2.5 text-left last:border-b-0",
                                    selectableClass(active),
                                  )}
                                >
                                  <FileSpreadsheet
                                    className="mt-0.5 size-3.5 shrink-0 text-text-tertiary"
                                    aria-hidden="true"
                                  />
                                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                                    {item.filename}
                                  </span>
                                </button>
                              );
                            })}
                        </div>
                      </FormField>
                    )}
                  </div>
                </div>
                <p className="shrink-0 border-t border-border px-4 py-2.5 text-[11px] leading-4 text-text-tertiary">
                  {t.registerHint}
                </p>
              </>
            )}
          </section>
        </SplitLayout>
      </Panel>

      <AppDialog
        open={detailOpen}
        title={selected?.filename ?? t.previewSteps}
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
              {t.inspect}
            </Button>
            <Button
              type="button"
              variant={detailTab === "result" ? "secondary" : "quiet"}
              onClick={() => setDetailTab("result")}
            >
              {t.resultPreview}
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
                  detailTab === "result" ? t.combinePreviewHint : messages.empty.preview
                }
              />
            )}
          </div>
        </div>
      </AppDialog>

      <AppDialog
        open={registerOpen}
        title={t.register}
        icon={<BookmarkPlus className="size-4 text-accent" aria-hidden="true" />}
        className="w-[min(22rem,92vw)]"
        minWidth={320}
        minHeight={220}
        zIndex={120}
        onClose={() => setRegisterOpen(false)}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setRegisterOpen(false)}>
              {messages.common.cancel}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={registerBusy || !registerChipName.trim()}
              onClick={() => void onRegisterChip()}
            >
              {registerBusy ? messages.common.saving : messages.common.save}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 p-4">
          <p className="text-[11px] leading-5 text-text-tertiary">{t.registerHint}</p>
          <FormField label={messages.workspace.chipName}>
            <input
              className="field-control"
              value={registerChipName}
              autoFocus
              onChange={(event) => setRegisterChipName(event.target.value)}
            />
          </FormField>
          <dl className="space-y-2 border-t border-border/60 pt-3 text-[11px] text-text-tertiary">
            <div className="flex gap-2">
              <dt className="w-14 shrink-0">{t.selectedFile}</dt>
              <dd className="min-w-0 truncate text-text-secondary">{selected?.filename ?? "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-14 shrink-0">{t.combineSetup}</dt>
              <dd className="text-text-secondary">{combineModeLabel}</dd>
            </div>
          </dl>
        </div>
      </AppDialog>
    </PageShell>
  );
}
