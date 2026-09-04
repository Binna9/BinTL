import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  BookmarkPlus,
  ChevronRight,
  Eye,
  FileSpreadsheet,
  Plus,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { CombineSetup } from "@/components/transform/CombineSetup";
import {
  PreviewGrid,
  StepFields,
  specFrom,
  usableSteps,
} from "@/components/transform/TransformEditorParts";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { SplitLayout } from "@/layouts/SplitLayout";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { MetaField } from "@/components/ui/meta-field";
import { PaneHeader } from "@/components/ui/pane-header";
import { Panel } from "@/components/ui/panel";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { fmtBytes } from "@/lib/format";
import { layout } from "@/lib/layout";
import { toastError, toastSuccess } from "@/lib/notifications";
import { HttpError } from "@/services/httpClient";
import { selectableClass } from "@/lib/selectable";
import {
  canPreviewCombine,
  combineDraftFromSpec,
  combineDraftToSpec,
  emptyCombineDraft,
  parseTransformSection,
  TRANSFORM_SECTIONS,
  type CombineDraft,
  type TransformEditorSection,
} from "@/lib/transformEditor";
import { chipApi } from "@/services/chips/chipApi";
import { datasetApi } from "@/services/transform/datasetApi";
import { transformApi } from "@/services/transform/transformApi";
import type { Dataset, FramePreview } from "@/types/dataset";
import type { ChipInputSlotResponse } from "@/types/chip";
import type {
  StepOp,
  TransformSpecV2,
  TransformStep,
} from "@/types/transform";

import {
  datasetFromSlot,
  defaultTransformName,
  emptyStep,
  KIND_APPEARANCE,
  KIND_ORDER,
  resolveColumnsAtStep,
  STEP_OP_ICONS,
  STEP_OPS,
} from "@/features/transform/transformEditorModel";
type AggregateFunction = "sum" | "count" | "mean" | "min" | "max";
type AggregateDraft = { column: string; function: AggregateFunction; alias: string };

export function TransformPage({ section: fixedSection }: { section?: TransformEditorSection }) {
  const { messages } = useLanguage();
  const {
    id,
    workspaceId: routeWorkspaceId,
    editorChipId: routeChipId,
  } = useParams<{ id: string; workspaceId: string; editorChipId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const t = messages.transform;
  const [editorSection, setEditorSection] = useState<TransformEditorSection>(() =>
    fixedSection ?? parseTransformSection(searchParams.get("section")),
  );
  const workspaceId = routeWorkspaceId ?? searchParams.get("workspace") ?? undefined;
  const chipId = routeChipId ?? searchParams.get("chip") ?? searchParams.get("input_chip") ?? undefined;
  const workspaceMode = Boolean(workspaceId && chipId);
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
    // Keep the available source files visible when the editor opens. The
    // groups remain collapsible, but the catalog must not look empty by
    // default.
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
  const [addStepOpen, setAddStepOpen] = useState(false);
  const addStepRef = useRef<HTMLDivElement>(null);
  const addStepMenuRef = useRef<HTMLDivElement>(null);
  const [addStepPos, setAddStepPos] = useState<{ top: number; left: number } | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registerChipName, setRegisterChipName] = useState("");
  const [registerBusy, setRegisterBusy] = useState(false);
  const [sourceMissing, setSourceMissing] = useState(false);
  const [inputSlot, setInputSlot] = useState<ChipInputSlotResponse | null>(null);
  const [combineDraft, setCombineDraft] = useState<CombineDraft | null>(null);
  const [rightPreview, setRightPreview] = useState<FramePreview | null>(null);
  const [aggregateGroupBy, setAggregateGroupBy] = useState<string[]>([]);
  const [aggregations, setAggregations] = useState<AggregateDraft[]>([]);

  const selected = datasets.find((item) => item.id === datasetId) ?? null;
  const columns = selected?.columns ?? [];
  const baseColumns =
    sourcePreview && sourcePreview.columns.length > 0 ? sourcePreview.columns : columns;
  const rightSelected =
    combineDraft?.rightDatasetId != null
      ? (datasets.find((item) => item.id === combineDraft.rightDatasetId) ?? null)
      : null;
  const rightColumns =
    rightPreview && rightPreview.columns.length > 0
      ? rightPreview.columns
      : (rightSelected?.columns ?? []);
  const cleanColumns = useMemo(
    () => resolveColumnsAtStep(baseColumns, steps, steps.length),
    [baseColumns, steps],
  );
  const commonJoinKeys = useMemo(() => {
    const rightNames = new Set(rightColumns.map((column) => column.name));
    return cleanColumns.filter((column) => rightNames.has(column.name));
  }, [cleanColumns, rightColumns]);
  const aggregateColumns = useMemo(() => {
    const byName = new Map(cleanColumns.map((column) => [column.name, column]));
    if (combineDraft?.mode === "join") {
      for (const column of rightColumns) byName.set(column.name, column);
    }
    return [...byName.values()];
  }, [cleanColumns, combineDraft?.mode, rightColumns]);
  const usableAggregations = aggregations.filter(
    (aggregation) => aggregation.column && aggregation.alias.trim(),
  );
  const canPreviewRecipe =
    canPreviewCombine(combineDraft, datasetId)
    || usableSteps(steps, baseColumns).length > 0
    || usableAggregations.length > 0;
  const combineModeLabel =
    combineDraft?.mode === "union" ? t.combineModeUnion : t.combineModeJoin;

  useEffect(() => {
    setEditorSection(fixedSection ?? parseTransformSection(searchParams.get("section")));
  }, [fixedSection, searchParams]);

  function changeSection(section: TransformEditorSection) {
    setEditorSection(section);
    navigate(editorPath(transformId, section), { replace: true });
  }

  function editorPath(
    nextTransformId?: string,
    nextSection: TransformEditorSection = editorSection,
  ) {
    const params = new URLSearchParams(searchParams);
    params.delete("workspace");
    params.delete("chip");
    params.delete("input_chip");
    if (nextSection === "clean") params.delete("section");
    else params.set("section", nextSection);
    const base = workspaceId && chipId
      ? `/workspace/${workspaceId}/chips/${chipId}/transform${nextTransformId ? `/${nextTransformId}` : ""}`
      : nextTransformId
        ? `/transform/${nextTransformId}`
        : "/transform";
    const query = params.toString();
    return query ? `${base}?${query}` : base;
  }

  function buildSpec(): TransformSpecV2 {
    const cleanSpec = specFrom(selected, steps, baseColumns);
    const combine = combineDraftToSpec(combineDraft);
    return {
      version: 3,
      sink: "parquet",
      read: cleanSpec.read,
      operations: [
        ...(cleanSpec.steps && cleanSpec.steps.length > 0
          ? [{ type: "clean" as const, steps: cleanSpec.steps }]
          : []),
        ...(combine?.mode === "join" && combine.right_dataset_id
          ? [{
              type: "join" as const,
              right_dataset_id: combine.right_dataset_id,
              on: combine.on ?? [],
              how: combine.how,
            }]
          : combine?.mode === "union"
            ? [{ type: "union" as const, dataset_ids: combine.union_dataset_ids ?? [] }]
            : []),
        ...(usableAggregations.length > 0
          ? [{
              type: "aggregate" as const,
              group_by: aggregateGroupBy,
              aggregations: usableAggregations,
            }]
          : []),
      ],
    };
  }

  const kindLabel: Record<string, string> = {
    upload: messages.transform.kindUpload,
    database: messages.transform.kindDatabase,
    transform: messages.transform.kindTransform,
    api: messages.transform.kindApi,
  };
  const stepLabels: Record<StepOp, string> = {
    select: messages.transform.opSelect,
    drop: messages.transform.opSelect,
    rename: messages.transform.opRename,
    filter: messages.transform.opFilter,
    cast: messages.transform.opCast,
    fill_null: messages.transform.opFillNull,
    sort: messages.transform.opSort,
    unique: messages.transform.opUnique,
  };
  const stepHints: Record<StepOp, string> = {
    select: messages.transform.opSelectHint,
    drop: messages.transform.opSelectHint,
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
    if (!workspaceId || !chipId) {
      setInputSlot(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        let slot = await chipApi.getInputSlot(workspaceId, chipId);
        let dataset = datasetFromSlot(slot);
        if (!dataset) {
          const chip = await chipApi.get(chipId);
          const datasetId =
            typeof chip.config.input_dataset_id === "string"
              ? chip.config.input_dataset_id.trim()
              : "";
          if (datasetId) {
            const file = await datasetApi.get(datasetId);
            slot = {
              mode: "materialized",
              dataset_id: file.id,
              source_chip_name: file.filename,
              dataset: file as unknown as Record<string, unknown>,
            };
            dataset = file;
          }
        }
        if (cancelled) return;
        setInputSlot(slot);
        if (!dataset) return;
        setDatasets((current) => {
          const exists = current.some((item) => item.id === dataset.id);
          if (exists) {
            return current.map((item) => (item.id === dataset.id ? { ...item, ...dataset } : item));
          }
          return [...current, dataset];
        });
        setDatasetId(dataset.id);
        setName((current) =>
          current || defaultTransformName(slot.source_chip_name || dataset.filename),
        );
      } catch (err) {
        if (!cancelled) toastError(messages.errors.workspace, err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, chipId, messages]);

  useEffect(() => {
    if (!id) {
      setTransformId(undefined);
      setSteps([]);
      setCombineDraft(null);
      setAggregateGroupBy([]);
      setAggregations([]);
      setRightPreview(null);
      setResultPreview(null);
      if (!workspaceMode) {
        setDatasetId(undefined);
        setName("");
        setSourcePreview(null);
      }
      return;
    }
    let cancelled = false;
    // Routes reuse this page component. Clear the previous recipe while the
    // requested one loads so /transform/:id never renders stale inputs.
    setTransformId(undefined);
    setDatasetId(undefined);
    setName("");
    setSteps([]);
    setCombineDraft(null);
    setAggregateGroupBy([]);
    setAggregations([]);
    setRightPreview(null);
    setResultPreview(null);
    void transformApi
      .get(id)
      .then((row) => {
        if (cancelled) return;
        setTransformId(row.id);
        setDatasetId(row.dataset_id);
        setName(row.name);
        const cleanOperation = row.spec?.operations?.find((operation) => operation.type === "clean");
        const combineOperation = row.spec?.operations?.find(
          (operation) => operation.type === "join" || operation.type === "union",
        );
        const aggregateOperation = row.spec?.operations?.find(
          (operation) => operation.type === "aggregate",
        );
        setSteps(
          cleanOperation?.type === "clean"
            ? cleanOperation.steps
            : Array.isArray(row.spec?.steps)
              ? row.spec.steps
              : [],
        );
        setCombineDraft(
          combineOperation?.type === "join"
            ? combineDraftFromSpec({
                mode: "join",
                right_dataset_id: combineOperation.right_dataset_id,
                on: combineOperation.on,
                how: combineOperation.how,
              })
            : combineOperation?.type === "union"
              ? combineDraftFromSpec({
                  mode: "union",
                  union_dataset_ids: combineOperation.dataset_ids,
                })
              : combineDraftFromSpec(row.spec?.combine),
        );
        setAggregateGroupBy(
          aggregateOperation?.type === "aggregate" ? aggregateOperation.group_by : [],
        );
        setAggregations(
          aggregateOperation?.type === "aggregate" ? aggregateOperation.aggregations : [],
        );
      })
      .catch((err) => {
        if (!cancelled) {
          toastError(messages.errors.workspace, err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, messages, workspaceMode]);

  useEffect(() => {
    if (!datasetId) {
      setSourcePreview(null);
      setSourceMissing(false);
      return;
    }
    if (selected?.status === "planned") {
      setSourceMissing(false);
      if (selected.columns.length > 0) {
        setSourcePreview({
          columns: selected.columns,
          rows: [],
          sampled_rows: 0,
          row_count: 0,
          truncated: false,
        });
      } else {
        setSourcePreview(null);
      }
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
  }, [datasetId, selected?.available, selected?.status, messages]);

  useEffect(() => {
    if (!combineDraft || combineDraft.mode !== "join" || !combineDraft.rightDatasetId) {
      setRightPreview(null);
      return;
    }
    let cancelled = false;
    void datasetApi
      .inspect(combineDraft.rightDatasetId, 100)
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
  }, [combineDraft?.rightDatasetId, combineDraft?.mode, messages]);

  useEffect(() => {
    if (!combineDraft || combineDraft.joinKeys.length > 0 || commonJoinKeys.length === 0) return;
    setCombineDraft((current) =>
      current ? { ...current, joinKeys: [commonJoinKeys[0]!.name] } : current,
    );
  }, [commonJoinKeys, combineDraft]);

  useEffect(() => {
    if (!detailOpen || !datasetId) return;
    const dataset = datasets.find((item) => item.id === datasetId) ?? null;
    if (dataset?.status === "planned") {
      setSourcePreview({
        columns: dataset.columns,
        rows: [],
        sampled_rows: 0,
        row_count: 0,
        truncated: false,
      });
      setResultPreview(null);
      setDetailLoading(false);
      return;
    }
    const spec = buildSpec();
    const previewCombine = canPreviewCombine(combineDraft, datasetId);
    const previewSteps = usableSteps(steps, baseColumns).length > 0;
    let cancelled = false;
    setDetailLoading(true);
    void Promise.allSettled([
      datasetApi.inspect(datasetId, 200, true),
      previewCombine || previewSteps
        ? datasetApi.preview(datasetId, spec, 200, true)
        : Promise.resolve(null),
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
        } else if (previewed.status === "rejected" && (previewCombine || previewSteps)) {
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
  }, [
    detailOpen,
    datasetId,
    detailTick,
    messages,
    steps,
    combineDraft,
    aggregateGroupBy,
    aggregations,
    selected?.status,
  ]);

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

  function openDetail(tab: "source" | "result") {
    if (!datasetId) return;
    setDetailTab(tab);
    setDetailOpen(true);
    setDetailTick((tick) => tick + 1);
  }

  function resetRecipe() {
    setSteps([]);
    setCombineDraft(null);
    setAggregateGroupBy([]);
    setAggregations([]);
    setRightPreview(null);
    setResultPreview(null);
    changeSection("clean");
  }

  function moveToNextTransform() {
    const currentIndex = TRANSFORM_SECTIONS.indexOf(editorSection);
    const next = TRANSFORM_SECTIONS[currentIndex + 1];
    if (next) changeSection(next);
  }

  async function saveTransformDefinition() {
    if (!datasetId) return;
    setBusy(true);
    try {
      const title = name.trim() || selected?.filename || messages.transform.untitled;
      if (transformId) {
        await transformApi.update(transformId, {
          name: title,
          dataset_id: datasetId,
          spec: buildSpec(),
          ...(chipId ? { input_chip_id: chipId } : {}),
        });
      } else {
        const row = await transformApi.create({
          name: title,
          dataset_id: datasetId,
          spec: buildSpec(),
          ...(chipId ? { input_chip_id: chipId } : {}),
        });
        setTransformId(row.id);
        setName(row.name);
        navigate(editorPath(row.id), { replace: true });
      }
      if (workspaceMode && workspaceId) {
        toastSuccess(messages.transform.saveToWorkspace);
        navigate(`/workspace/${workspaceId}/chips/${chipId}`);
        return;
      }
      toastSuccess(messages.query.taskRegistered);
    } catch (err) {
      toastError(messages.errors.saveTransform, err);
    } finally {
      setBusy(false);
    }
  }

  async function onRegisterChip() {
    if (!datasetId || !registerChipName.trim()) return;
    setRegisterBusy(true);
    try {
      const title = name.trim() || selected?.filename || messages.transform.untitled;
      let savedTransformId = transformId;
      if (savedTransformId) {
        await transformApi.update(savedTransformId, {
          name: title,
          dataset_id: datasetId,
          spec: buildSpec(),
          ...(chipId ? { input_chip_id: chipId } : {}),
        });
      } else {
        const row = await transformApi.create({
          name: title,
          dataset_id: datasetId,
          spec: buildSpec(),
          ...(chipId ? { input_chip_id: chipId } : {}),
        });
        savedTransformId = row.id;
        setTransformId(row.id);
        setName(row.name);
        navigate(editorPath(row.id), { replace: true });
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

  function openRegister() {
    if (workspaceMode) {
      void saveTransformDefinition();
      return;
    }
    setRegisterChipName(name.trim() || selected?.filename || messages.transform.untitled);
    setRegisterOpen(true);
  }

  function confirmRecipe() {
    if (workspaceMode || transformId) {
      void saveTransformDefinition();
      return;
    }
    openRegister();
  }

  function updateStep(index: number, next: TransformStep) {
    setSteps((current) => current.map((step, i) => (i === index ? next : step)));
  }

  const activePreview = detailTab === "result" ? resultPreview : sourcePreview;
  const previewHeaders = activePreview?.columns.map((column) => column.name) ?? [];

  return (
    <PageShell>
      <PageHeader
        iconName="jobs"
        eyebrow={messages.transform.eyebrow}
        title={t.title}
        description={t.description}
        actions={
          <>
            <Button
              type="button"
              variant="quiet"
              className="gap-2"
              disabled={busy}
              onClick={resetRecipe}
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {messages.transform.reset}
            </Button>
            <Button
              type="button"
              className="gap-2"
              disabled={!datasetId || busy || editorSection === TRANSFORM_SECTIONS.at(-1)}
              onClick={moveToNextTransform}
            >
              <ChevronRight className="size-3.5" aria-hidden="true" />
              {messages.transform.nextTransform}
            </Button>
            <Button
              variant="primary"
              type="button"
              className="gap-2"
              disabled={!datasetId || busy}
              onClick={confirmRecipe}
            >
              <BookmarkPlus className="size-3.5" aria-hidden="true" />
              {busy ? messages.common.saving : messages.common.confirm}
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
            {workspaceMode ? (
              <>
                <PaneHeader
                  title={messages.transform.catalog}
                  meta={messages.common.count(
                    inputSlot?.mode === "unwired" ? 0 : 1,
                  )}
                />
                <div className="scroll-pane min-h-0 flex-1 overflow-auto bg-surface">
                  {inputSlot?.mode === "unwired" ? (
                    <p className="p-3 text-sm leading-6 text-text-secondary">
                      {messages.transform.unwiredHint}
                    </p>
                  ) : (
                    <div
                      className={cn(
                        "flex w-full min-w-0 items-start gap-2 border-b border-border px-3 py-2.5 text-left",
                        selectableClass(true),
                      )}
                    >
                      <FileSpreadsheet
                        className="mt-0.5 size-3.5 shrink-0 text-text-tertiary"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block break-all text-[13px] font-medium leading-4">
                          {inputSlot?.source_chip_name
                            || selected?.filename
                            || messages.transform.untitled}
                          {inputSlot?.mode === "planned" || selected?.status === "planned" ? (
                            <span className="ml-1 text-[11px] font-normal text-accent">
                              ({messages.transform.plannedInput})
                            </span>
                          ) : selected && !selected.available ? (
                            <span className="ml-1 text-[11px] font-normal text-warning">
                              ({messages.transform.sourceUnavailable})
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block text-[11px] leading-4 text-text-tertiary">
                          {inputSlot?.mode === "planned"
                            ? messages.transform.schemaOnlyHint
                            : selected?.row_count != null
                              ? messages.common.rows(selected.row_count)
                              : selected?.origin?.connection_name
                                ? `${selected.origin.connection_name} · ${selected.origin.table_name}`
                                : selected?.size_bytes != null
                                  ? fmtBytes(selected.size_bytes)
                                  : messages.transform.pickFile}
                        </span>
                      </span>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
            <PaneHeader
              title={messages.transform.catalog}
              meta={messages.common.count(datasets.length)}
            />
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
                                  setName((current) =>
                                    current || defaultTransformName(item.filename),
                                  );
                                }
                              }}
                            >
                              <FileSpreadsheet className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
                              <span className="min-w-0 flex-1">
                                <span className="block break-all text-[13px] font-medium leading-4">
                                  {item.filename}
                                  {item.status === "planned" ? (
                                    <span className="ml-1 text-[11px] font-normal text-accent">
                                      ({messages.transform.plannedInput})
                                    </span>
                                  ) : !item.available ? (
                                    <span className="ml-1 text-[11px] font-normal text-warning">
                                      ({messages.transform.sourceUnavailable})
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
              </>
            )}
          </aside>

          <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            <PaneHeader
              title={
                editorSection === "combine"
                  ? t.combineSetup
                  : editorSection === "aggregate"
                    ? t.aggregateTitle
                    : messages.transform.setup
              }
              meta={
                editorSection === "combine"
                  ? combineDraft
                    ? combineModeLabel
                    : t.combineInactive
                  : editorSection === "aggregate"
                    ? messages.common.count(aggregations.length)
                    : messages.common.count(steps.length)
              }
              afterMeta={
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-7 gap-1 px-2 text-[11px]"
                    disabled={!datasetId || busy}
                    onClick={() => openDetail(canPreviewRecipe ? "result" : "source")}
                  >
                    <Eye className="size-3.5" aria-hidden="true" />
                    {messages.transform.previewSteps}
                  </Button>
                {editorSection === "clean" ? (
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
                          className="scroll-pane fixed z-[220] w-72 overflow-y-auto rounded-xl border border-border bg-surface py-1 shadow-[0_10px_28px_rgba(15,23,42,0.14)] dark:shadow-[0_14px_32px_rgba(0,0,0,0.48)]"
                          style={{ top: addStepPos.top, left: addStepPos.left, maxHeight: 320 }}
                        >
                          {STEP_OPS.map((op) => {
                            const Icon = STEP_OP_ICONS[op];
                            return (
                              <button
                                key={op}
                                type="button"
                                role="menuitem"
                                className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-accent-subtle"
                                onClick={() => {
                                  if (op === "select") {
                                    const available = resolveColumnsAtStep(
                                      baseColumns,
                                      steps,
                                      steps.length,
                                    );
                                    setSteps((current) => [
                                      ...current,
                                      {
                                        op: "select",
                                        columns: available.map((column) => column.name),
                                      },
                                    ]);
                                  } else {
                                    setSteps((current) => [...current, emptyStep(op)]);
                                  }
                                  setAddStepOpen(false);
                                }}
                              >
                                <Icon
                                  className="mt-0.5 size-4 shrink-0 text-text-tertiary"
                                  aria-hidden="true"
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block text-[13px] font-semibold text-text">
                                    {stepLabels[op]}
                                  </span>
                                  <span className="mt-0.5 block text-[11px] leading-4 text-text-tertiary">
                                    {stepHints[op]}
                                  </span>
                                </span>
                              </button>
                            );
                          })}
                        </div>,
                        document.body,
                      )
                    : null}
                </div>
                ) : null
              }
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
                {sourceMissing ? (
                  <p className="border-b border-border px-4 py-2.5 text-[11px] leading-5 text-warning">
                    {messages.transform.sourceFileMissing}
                  </p>
                ) : null}
                {editorSection === "aggregate" ? (
                  <div className="scroll-pane min-h-0 flex-1 space-y-5 overflow-auto p-4">
                    <section className="rounded-lg border border-border bg-raised p-4">
                      <h3 className="text-sm font-semibold text-text">{t.aggregateGroupBy}</h3>
                      <p className="mt-1 text-xs leading-5 text-text-tertiary">
                        {t.aggregateGroupByHint}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {aggregateColumns.map((column) => (
                          <label
                            key={column.name}
                            className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs"
                          >
                            <input
                              type="checkbox"
                              checked={aggregateGroupBy.includes(column.name)}
                              onChange={(event) =>
                                setAggregateGroupBy((current) =>
                                  event.target.checked
                                    ? [...current, column.name]
                                    : current.filter((name) => name !== column.name),
                                )
                              }
                            />
                            {column.name}
                          </label>
                        ))}
                      </div>
                    </section>
                    <section className="rounded-lg border border-border bg-raised p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-semibold text-text">{t.aggregateValues}</h3>
                          <p className="mt-1 text-xs leading-5 text-text-tertiary">
                            {t.aggregateValuesHint}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={aggregateColumns.length === 0}
                          onClick={() => {
                            const column = aggregateColumns[0]?.name ?? "";
                            setAggregations((current) => [
                              ...current,
                              { column, function: "sum", alias: column ? `${column}_sum` : "" },
                            ]);
                          }}
                        >
                          <Plus className="size-3.5" aria-hidden="true" />
                          {t.aggregateAdd}
                        </Button>
                      </div>
                      <div className="mt-3 space-y-2">
                        {aggregations.length === 0 ? (
                          <p className="py-4 text-center text-sm text-text-tertiary">
                            {t.aggregateEmpty}
                          </p>
                        ) : aggregations.map((aggregation, index) => (
                          <div
                            key={index}
                            className="grid gap-2 rounded-md border border-border bg-surface p-2 md:grid-cols-[1fr_0.8fr_1fr_auto]"
                          >
                            <select
                              className="h-9 rounded-md border border-border bg-surface px-2 text-xs text-text"
                              value={aggregation.column}
                              onChange={(event) =>
                                setAggregations((current) => current.map((item, itemIndex) =>
                                  itemIndex === index ? { ...item, column: event.target.value } : item,
                                ))
                              }
                            >
                              {aggregateColumns.map((column) => (
                                <option key={column.name} value={column.name}>{column.name}</option>
                              ))}
                            </select>
                            <select
                              className="h-9 rounded-md border border-border bg-surface px-2 text-xs text-text"
                              value={aggregation.function}
                              onChange={(event) =>
                                setAggregations((current) => current.map((item, itemIndex) =>
                                  itemIndex === index
                                    ? { ...item, function: event.target.value as AggregateFunction }
                                    : item,
                                ))
                              }
                            >
                              {(["sum", "count", "mean", "min", "max"] as AggregateFunction[]).map((fn) => (
                                <option key={fn} value={fn}>{t.aggregateFunctions[fn]}</option>
                              ))}
                            </select>
                            <input
                              className="h-9 rounded-md border border-border bg-surface px-2 text-xs text-text outline-none focus:border-accent"
                              value={aggregation.alias}
                              placeholder={t.aggregateAlias}
                              onChange={(event) =>
                                setAggregations((current) => current.map((item, itemIndex) =>
                                  itemIndex === index ? { ...item, alias: event.target.value } : item,
                                ))
                              }
                            />
                            <Button
                              type="button"
                              variant="quiet"
                              aria-label={messages.common.delete}
                              onClick={() => setAggregations((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                            >
                              <Trash2 className="size-3.5" aria-hidden="true" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    </section>
                  </div>
                ) : editorSection === "combine" && !combineDraft ? (
                  <div className="scroll-pane min-h-0 flex-1 overflow-auto p-4">
                    <div className="max-w-xl rounded-lg border border-border bg-raised p-4">
                      <p className="text-sm font-medium text-text">{t.combineInactive}</p>
                      <p className="mt-1 text-sm leading-6 text-text-secondary">{t.combineIdleHint}</p>
                      <Button
                        type="button"
                        variant="secondary"
                        className="mt-3"
                        onClick={() => setCombineDraft(emptyCombineDraft())}
                      >
                        {t.combineEnable}
                      </Button>
                    </div>
                  </div>
                ) : editorSection === "combine" && combineDraft ? (
                  <CombineSetup
                    messages={messages}
                    draft={combineDraft}
                    datasetId={datasetId}
                    datasets={datasets}
                    leftColumns={cleanColumns}
                    commonJoinKeys={commonJoinKeys}
                    onChange={setCombineDraft}
                    onDisable={() => setCombineDraft(null)}
                  />
                ) : (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="scroll-pane min-h-0 flex-1 overflow-auto">
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
                            columns={resolveColumnsAtStep(baseColumns, steps, index)}
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
                )}
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
                    ? editorSection === "combine" && !canPreviewCombine(combineDraft, datasetId)
                      ? t.combinePreviewHint
                      : messages.transform.previewHint
                    : messages.empty.preview
                }
              />
            )}
          </div>
        </div>
      </AppDialog>

      <AppDialog
        open={registerOpen}
        title={messages.transform.register}
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
          <p className="text-[11px] leading-5 text-text-tertiary">{messages.transform.registerHint}</p>
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
              <dt className="w-14 shrink-0">{messages.transform.selectedFile}</dt>
              <dd className="min-w-0 truncate text-text-secondary">{selected?.filename ?? "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-14 shrink-0">{messages.transform.steps}</dt>
              <dd className="text-text-secondary">{messages.transform.registerSummarySteps(steps.length)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-14 shrink-0">{messages.transform.sectionCombine}</dt>
              <dd className="text-text-secondary">
                {messages.transform.registerSummaryCombine(Boolean(combineDraftToSpec(combineDraft)))}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-14 shrink-0">{messages.transform.sectionAggregate}</dt>
              <dd className="text-text-secondary">
                {messages.transform.registerSummaryAggregate(aggregations.length)}
              </dd>
            </div>
          </dl>
        </div>
      </AppDialog>
    </PageShell>
  );
}
