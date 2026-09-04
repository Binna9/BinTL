import { DragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowRight, CheckCircle2, CircleAlert, DatabaseZap, FolderOpen, Pencil, Play, Puzzle, RefreshCw, Save, Spline, Workflow, X } from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { ChipDetailView } from "@/components/chips/ChipDetailView";
import {
  ChipContextMenu,
  type ChipContextMenuState,
} from "@/components/workspace/ChipContextMenu";
import {
  ChipPlaceDialog,
  type TransformPlaceDraft,
} from "@/components/workspace/ChipPlaceDialog";
import { SplitLayout } from "@/layouts/SplitLayout";
import { StatusPill } from "@/components/StatusPill";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { WorkspaceManageDialog } from "@/components/workspace/WorkspaceManageDialog";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { layout } from "@/lib/layout";
import { showConfirm, toastError, toastSuccess } from "@/lib/notifications";
import { datasetApi } from "@/services/transform/datasetApi";
import { chipApi } from "@/services/chips/chipApi";
import { workspaceApi } from "@/services/workspace/workspaceApi";
import type { Dataset } from "@/types/dataset";
import type { Chip, ChipEdge, ChipEdgeKind, ChipRun } from "@/types/chip";
import { DRAFT_CHIP_ID_PREFIX, isDraftChipId } from "@/types/chip";
import type { Workspace, WorkspaceFolder, WorkspaceLayout } from "@/types/workspace";
import {
  ACTIVE_STATUSES,
  CANVAS_H,
  CANVAS_W,
  CHIP_PLACE_GAP,
  NODE_H,
  NODE_W,
  TOOL_KIND,
  canHaveDataEdge,
  canvasPoint,
  chipFixedInputId,
  chipInMarquee,
  chipKindLabel,
  chipRunOrder,
  clampMarqueePoint,
  clampPoint,
  cloneCanvas,
  edgeGeometry,
  edgeInMarquee,
  fallbackPoint,
  folderPathLabel,
  nodesFromLayout,
  normalizeMarquee,
  omitPoint,
  pointerOutsideCanvas,
  previewGeometry,
  routeSides,
  asPortSide,
  releasePointer,
  roundPoint,
  scrollCanvasFromPointer,
  wireTone,
  type CanvasSnapshot,
  type MarqueeBox,
  type Point,
  type PortSide,
} from "@/features/workspace/workspaceCanvasModel";

import {
  EdgeWire,
  ChipLinkHandle,
  isEditableTarget,
  ShortcutHint,
  ToolIconButton,
  WorkspaceBrowserPanel,
  WorkspaceLayers,
  WorkspaceMinimap,
} from "@/components/workspace/WorkspaceCanvasParts";
export function WorkspacePage() {
  const { messages } = useLanguage();
  const navigate = useNavigate();
  const { workspaceId, chipId } = useParams<{ workspaceId: string; chipId: string }>();
  const currentWorkspaceRef = useRef(workspaceId);
  const refreshRequestRef = useRef(0);
  const canvasRef = useRef<HTMLDivElement>(null);
  const pendingViewRef = useRef<Point | null>(null);
  const positionsRef = useRef<Record<string, Point>>({});
  const savedRef = useRef<CanvasSnapshot>({ chips: [], positions: {}, edges: [] });
  const savedIdsRef = useRef(new Set<string>());
  const confirmingSaveRef = useRef(false);
  const dirtyRef = useRef(false);
  const busyRef = useRef(false);
  const requestSaveRef = useRef<() => void>(() => {});
  const resetCanvasRef = useRef<() => void>(() => {});
  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    id: string;
    dx: number;
    dy: number;
    startX: number;
    startY: number;
    moved: boolean;
    additive: boolean;
    wasSelected: boolean;
    origins: Record<string, Point>;
  } | null>(null);
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
    moved: boolean;
  } | null>(null);
  const marqueeRef = useRef<{
    pointerId: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    moved: boolean;
    additive: boolean;
  } | null>(null);
  currentWorkspaceRef.current = workspaceId;

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [folders, setFolders] = useState<WorkspaceFolder[]>([]);
  const [layersOpen, setLayersOpen] = useState(true);
  const [chips, setChips] = useState<Chip[]>([]);
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  const [catalogChips, setCatalogChips] = useState<Chip[]>([]);
  const [edges, setEdges] = useState<ChipEdge[]>([]);
  const [runs, setRuns] = useState<ChipRun[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [canvasView, setCanvasView] = useState({ width: 800, height: 600 });
  const [canvasScroll, setCanvasScroll] = useState({ x: 0, y: 0 });
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  const [selectedChipIds, setSelectedChipIds] = useState<string[]>([]);
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null);
  const [edgeTool, setEdgeTool] = useState<ChipEdgeKind>("data");
  const selectedChipIdsRef = useRef(selectedChipIds);
  selectedChipIdsRef.current = selectedChipIds;
  const selectedEdgeIdsRef = useRef(selectedEdgeIds);
  selectedEdgeIdsRef.current = selectedEdgeIds;
  const [linking, setLinking] = useState<{
    fromId: string;
    kind: ChipEdgeKind;
    fromSide: PortSide;
    x: number;
    y: number;
  } | null>(null);
  const linkingRef = useRef(linking);
  linkingRef.current = linking;

  const [pendingPlace, setPendingPlace] = useState<{
    kind: "extract" | "transform";
    point: Point;
  } | null>(null);
  const [chipMenu, setChipMenu] = useState<ChipContextMenuState | null>(null);
  const [infoChip, setInfoChip] = useState<Chip | null>(null);
  const [propsChip, setPropsChip] = useState<Chip | null>(null);
  const [propsName, setPropsName] = useState("");
  const [propsBusy, setPropsBusy] = useState(false);
  positionsRef.current = positions;
  dirtyRef.current = dirty;
  busyRef.current = busy;

  const selectedWorkspace = workspaces.find((item) => item.id === workspaceId);
  const workspaceFolderPath = folderPathLabel(
    selectedWorkspace?.folder_id,
    folders,
    messages.workspace.topLevel,
  );
  const workspaceName = selectedWorkspace?.name ?? messages.workspace.selectWorkspace;
  const hasActiveRun = runs.some((run) => ACTIVE_STATUSES.has(run.status));
  const canvasWorld = useMemo(() => ({ width: CANVAS_W, height: CANVAS_H }), []);

  function rememberSaved(
    nextChips: Chip[],
    nextPositions: Record<string, Point>,
    nextEdges: ChipEdge[],
  ) {
    savedRef.current = cloneCanvas(nextChips, nextPositions, nextEdges);
    savedIdsRef.current = new Set(nextChips.map((chip) => chip.id));
    setDirty(false);
  }

  function positionsFrom(nextChips: Chip[], layout?: WorkspaceLayout) {
    const stored = nodesFromLayout(layout);
    const next: Record<string, Point> = {};
    nextChips.forEach((chip, index) => {
      next[chip.id] = stored[chip.id] ?? fallbackPoint(index);
    });
    return next;
  }

  function markDirty(
    nextChips: Chip[],
    nextPositions: Record<string, Point>,
    nextEdges: ChipEdge[],
  ) {
    const saved = savedRef.current;
    const dirtyNow = nextChips.length !== saved.chips.length
      || nextEdges.length !== saved.edges.length
      || nextChips.some((chip) => {
        const original = saved.chips.find((item) => item.id === chip.id);
        return !original
          || original.name !== chip.name
          || JSON.stringify(original.config) !== JSON.stringify(chip.config);
      })
      || nextChips.some((chip) => {
        const currentPoint = nextPositions[chip.id];
        const savedPoint = saved.positions[chip.id];
        return !currentPoint || !savedPoint
          || currentPoint.x !== savedPoint.x
          || currentPoint.y !== savedPoint.y;
      })
      || nextEdges.some((edge) => {
        const original = saved.edges.find((item) => item.id === edge.id);
        return !original
          || original.kind !== edge.kind
          || original.from_chip_id !== edge.from_chip_id
          || original.to_chip_id !== edge.to_chip_id;
      });
    setDirty(dirtyNow);
  }

  function dropEdgesLocally(edgeIdsToDrop: string[]) {
    if (edgeIdsToDrop.length === 0) return;
    const dropSet = new Set(edgeIdsToDrop);
    const nextEdges = edges.filter((edge) => !dropSet.has(edge.id));
    setEdges(nextEdges);
    setSelectedEdgeIds((current) => current.filter((id) => !dropSet.has(id)));
    markDirty(chips, positionsRef.current, nextEdges);
  }

  async function requestDeleteEdge(edgeId: string) {
    const edge = edges.find((item) => item.id === edgeId);
    if (!edge) return;
    const fromName = chips.find((chip) => chip.id === edge.from_chip_id)?.name
      ?? edge.from_chip_id.slice(0, 8);
    const toName = chips.find((chip) => chip.id === edge.to_chip_id)?.name
      ?? edge.to_chip_id.slice(0, 8);
    const confirmed = await showConfirm(
      messages.workspace.deleteEdgeTitle,
      messages.workspace.deleteEdgeMessage(fromName, toName),
      { tone: "danger", confirmLabel: messages.common.delete },
    );
    if (!confirmed || currentWorkspaceRef.current !== workspaceId) return;
    dropEdgesLocally([edgeId]);
  }

  async function connectChips(fromId: string, toId: string, kindValue: ChipEdgeKind) {
    if (fromId === toId) return;
    const from = chips.find((chip) => chip.id === fromId);
    const to = chips.find((chip) => chip.id === toId);
    if (!from || !to || !workspaceId) return;
    const kind = kindValue;
    if (kind === "data" && !canHaveDataEdge(from.kind, to.kind)) {
      toastError(messages.workspace.dataEdgeInvalidPair);
      return;
    }
    if (kind === "data" && to.kind === "transform" && chipFixedInputId(to)) {
      toastError(messages.workspace.dataEdgeNeedsPipelineTransform);
      return;
    }
    const existing = edges.filter(
      (edge) => edge.from_chip_id === fromId && edge.to_chip_id === toId,
    );
    if (existing.some((edge) => edge.kind === kind) && existing.length === 1) {
      toastError(messages.workspace.edgeAlreadySame);
      return;
    }
    if (existing.length > 0) {
      const confirmed = await showConfirm(
        messages.workspace.replaceEdgeTitle,
        messages.workspace.replaceEdgeMessage(from.name, to.name),
        { confirmLabel: messages.workspace.replaceEdgeConfirm },
      );
      if (!confirmed || currentWorkspaceRef.current !== workspaceId) return;
    }
    const fromPoint = positionsRef.current[fromId] ?? fallbackPoint(0);
    const toPoint = positionsRef.current[toId] ?? fallbackPoint(0);
    const route = routeSides(fromPoint, toPoint);
    const created: ChipEdge = {
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      from_chip_id: fromId,
      to_chip_id: toId,
      kind,
      from_port: route.fromSide,
      to_port: route.toSide,
    };
    const dropIds = new Set(existing.map((edge) => edge.id));
    const nextEdges = [
      ...edges.filter((edge) => !dropIds.has(edge.id)),
      created,
    ];
    setEdges(nextEdges);
    setSelectedEdgeIds([created.id]);
    setSelectedChipIds([]);
    markDirty(chips, positionsRef.current, nextEdges);
  }

  useEffect(() => {
    let cancelled = false;
    setBusy(false);
    setLoading(true);
    Promise.all([
      workspaceApi.list(),
      workspaceApi.listFolders(),
      datasetApi.list(),
    ])
      .then(([workspaceResponse, folderResponse, datasetResponse]) => {
        if (cancelled) return;
        setWorkspaces(workspaceResponse.workspaces);
        setFolders(folderResponse.folders);
        setDatasets(datasetResponse.datasets);
        if (!workspaceId && workspaceResponse.workspaces.length > 0) {
          navigate(`/workspace/${workspaceResponse.workspaces[0].id}`, { replace: true });
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) toastError(messages.workspace.loadError, reason);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [messages, navigate, workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      setChips([]);
      setEdges([]);
      setRuns([]);
      setPositions({});
      setSelectedChipIds([]);
      setSelectedEdgeIds([]);
      rememberSaved([], {}, []);
      pendingViewRef.current = null;
      return;
    }
    let cancelled = false;
    pendingViewRef.current = null;
    setLoading(true);
    Promise.all([
      workspaceApi.get(workspaceId),
      chipApi.list(workspaceId),
      chipApi.listRuns(workspaceId),
      chipApi.listCatalog(),
    ])
      .then(([workspace, chipResponse, runResponse, catalogResponse]) => {
        if (cancelled) return;
        setWorkspaces((current) => {
          const exists = current.some((item) => item.id === workspace.id);
          return exists
            ? current.map((item) => (item.id === workspace.id ? workspace : item))
            : [...current, workspace];
        });
        const nextPositions = positionsFrom(chipResponse.chips, workspace.layout);
        const nextEdges = workspace.edges ?? [];
        pendingViewRef.current = workspace.layout.view ?? { x: 0, y: 0 };
        setChips(chipResponse.chips);
        setEdges(nextEdges);
        setRuns(runResponse.runs);
        setCatalogChips(catalogResponse.chips);
        setPositions(nextPositions);
        setSelectedChipIds([]);
        setSelectedEdgeIds([]);
        rememberSaved(chipResponse.chips, nextPositions, nextEdges);
      })
      .catch((reason: unknown) => {
        if (!cancelled) toastError(messages.workspace.loadError, reason);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [messages, workspaceId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const update = () => {
      setCanvasView({ width: canvas.clientWidth, height: canvas.clientHeight });
      setCanvasScroll({ x: canvas.scrollLeft, y: canvas.scrollTop });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    canvas.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      canvas.removeEventListener("scroll", update);
    };
  }, [workspaceId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const view = pendingViewRef.current;
    if (!canvas || !view || loading) return;
    canvas.scrollTo(view.x, view.y);
    pendingViewRef.current = null;
  }, [canvasWorld.height, canvasWorld.width, loading, positions, workspaceId]);

  useEffect(() => {
    if (!workspaceId || !hasActiveRun) return;
    let cancelled = false;
    let toasted = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await chipApi.listRuns(workspaceId, { silent: true });
        if (cancelled) return;
        const stillActive = response.runs.some((run) => ACTIVE_STATUSES.has(run.status));
        if (stillActive) {
          setRuns(response.runs);
          toasted = false;
          timer = window.setTimeout(() => void poll(), 2000);
        } else {
          const datasetResponse = await datasetApi.list();
          if (cancelled) return;
          setRuns(response.runs);
          setDatasets(datasetResponse.datasets);
          toasted = false;
        }
      } catch (reason) {
        if (!cancelled) {
          if (!toasted) {
            toastError(messages.workspace.runLoadError, reason);
            toasted = true;
          }
          timer = window.setTimeout(() => void poll(), 2000);
        }
      }
    };
    timer = window.setTimeout(() => void poll(), 2000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [hasActiveRun, messages, workspaceId]);

  function transformEditorPath(chip: Chip) {
    if (!workspaceId) return "/workspace";
    const bound = chip.binding?.ref_kind === "transform" ? chip.binding.ref_id : undefined;
    const base = `/workspace/${workspaceId}/chips/${chip.id}/transform`;
    return bound ? `${base}/${bound}` : base;
  }

  function openTransformEditor(chip: Chip) {
    if (chip.kind !== "transform") return;
    if (isDraftChipId(chip.id)) {
      toastError(messages.workspace.saveFirst);
      return;
    }
    void (async () => {
      if (dirtyRef.current) {
        const saved = await saveCanvas();
        if (!saved) return;
      }
      if (!workspaceId || currentWorkspaceRef.current !== workspaceId) return;
      navigate(transformEditorPath(chip));
    })();
  }

  async function waitForChipRun(chipId: string) {
    if (!workspaceId) return;
    for (;;) {
      if (currentWorkspaceRef.current !== workspaceId) return;
      const response = await chipApi.listRuns(workspaceId, { silent: true });
      setRuns(response.runs);
      const latest = response.runs.find((run) => run.chip_id === chipId);
      if (!latest || !ACTIVE_STATUSES.has(latest.status)) {
        if (latest?.status === "failed") {
          throw new Error(latest.error_message || messages.workspace.runChipError);
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  async function runWorkspace() {
    if (!workspaceId) return;
    if (dirty) {
      toastError(messages.workspace.saveFirst);
      return;
    }
    const order = chipRunOrder(chips, edges);
    if (!order) {
      toastError(messages.workspace.runCycleError);
      return;
    }
    const runnable = order.filter((chip) => chip.kind !== "load");
    if (runnable.length === 0) return;
    setBusy(true);
    try {
      for (const chip of runnable) {
        if (currentWorkspaceRef.current !== workspaceId) return;
        await chipApi.run(chip.id, { workspace_id: workspaceId });
        await waitForChipRun(chip.id);
      }
      toastSuccess(messages.workspace.runQueued);
    } catch (reason) {
      toastError(messages.workspace.runChipError, reason);
    } finally {
      setBusy(false);
    }
  }

  async function runSingleChip(chip: Chip) {
    if (!workspaceId) return;
    if (isDraftChipId(chip.id)) {
      toastError(messages.workspace.saveFirst);
      return;
    }
    if (dirty) {
      toastError(messages.workspace.saveFirst);
      return;
    }
    if (chip.kind === "load") {
      toastError(messages.workspace.loadUnavailable);
      return;
    }
    setBusy(true);
    try {
      await chipApi.run(chip.id, { workspace_id: workspaceId });
      await waitForChipRun(chip.id);
      toastSuccess(messages.workspace.runQueued);
    } catch (reason) {
      toastError(messages.workspace.runChipError, reason);
    } finally {
      setBusy(false);
    }
  }

  function openChipProperties(chip: Chip) {
    setPropsChip(chip);
    setPropsName(chip.name);
  }

  async function saveChipProperties() {
    if (!propsChip || !workspaceId) return;
    const name = propsName.trim();
    if (!name) return;
    if (isDraftChipId(propsChip.id)) {
      const nextChips = chips.map((item) => (
        item.id === propsChip.id ? { ...item, name } : item
      ));
      setChips(nextChips);
      setPropsChip(null);
      markDirty(nextChips, positionsRef.current, edges);
      toastSuccess(messages.workspace.chipPropertiesSaved);
      return;
    }
    setPropsBusy(true);
    try {
      const updated = await chipApi.update(propsChip.id, { name });
      setChips((current) =>
        current.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)),
      );
      setCatalogChips((current) =>
        current.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)),
      );
      setPropsChip(null);
      toastSuccess(messages.workspace.chipPropertiesSaved);
    } catch (reason) {
      toastError(messages.workspace.saveChipError, reason);
    } finally {
      setPropsBusy(false);
    }
  }

  function openChipContextMenu(chip: Chip, event: ReactMouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    setSelectedChipIds([chip.id]);
    setSelectedEdgeIds([]);
    setChipMenu({ chip });
  }

  useEffect(() => {
    if (!chipId || !workspaceId || chips.length === 0) return;
    const chip = chips.find((item) => item.id === chipId);
    if (!chip) {
      navigate(`/workspace/${workspaceId}`, { replace: true });
      return;
    }
    setSelectedChipIds((current) => (
      current.length === 1 && current[0] === chipId ? current : [chipId]
    ));
    navigate(`/workspace/${workspaceId}`, { replace: true });
  }, [chipId, workspaceId, chips, navigate]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setLinking(null);
        setSelectedEdgeIds([]);
        setSelectedChipIds([]);
        setMarquee(null);
        marqueeRef.current = null;
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (isEditableTarget(event.target)) return;
        if (
          selectedChipIdsRef.current.length > 0
          || selectedEdgeIdsRef.current.length > 0
        ) {
          event.preventDefault();
          void deleteSelectedLayers();
        }
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        if (event.repeat) return;
        requestSaveRef.current();
        return;
      }
      if (key !== "z" || event.shiftKey) return;
      if (isEditableTarget(event.target)) return;
      if (!workspaceId || busyRef.current || !dirtyRef.current || confirmingSaveRef.current) {
        return;
      }
      event.preventDefault();
      resetCanvasRef.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [workspaceId, chips, edges]);

  function placeTool(toolKind: "extract" | "transform", point: Point) {
    if (!workspaceId) return;
    setPendingPlace({ kind: toolKind, point });
  }

  function placeCatalogChips(catalogChipsToPlace: Chip[], origin: Point) {
    if (catalogChipsToPlace.length === 0) return;
    let nextPositions = { ...positionsRef.current };
    let nextChips = [...chips];
    const placedIds: string[] = [];
    catalogChipsToPlace.forEach((catalogChip, index) => {
      const nextPoint = clampPoint({
        x: origin.x + index * (NODE_W + CHIP_PLACE_GAP),
        y: origin.y,
      });
      nextPositions[catalogChip.id] = nextPoint;
      if (!nextChips.some((chip) => chip.id === catalogChip.id)) {
        nextChips = [catalogChip, ...nextChips];
      }
      placedIds.push(catalogChip.id);
    });
    setChips(nextChips);
    setPositions(nextPositions);
    markDirty(nextChips, nextPositions, edges);
    setSelectedChipIds(placedIds);
    setSelectedEdgeIds([]);
    if (!workspaceId) return;
    if (placedIds.length >= 1) {
      navigate(`/workspace/${workspaceId}`);
    }
  }

  function confirmCatalogChips(chipIds: string[]) {
    if (!pendingPlace || chipIds.length === 0) return;
    const picked = chipIds
      .map((id) => catalogChips.find((chip) => chip.id === id))
      .filter((chip): chip is Chip => Boolean(chip));
    placeCatalogChips(picked, pendingPlace.point);
    setPendingPlace(null);
  }

  function cancelPlaceChip() {
    setPendingPlace(null);
  }

  function placeNewTransformChip(draft: TransformPlaceDraft) {
    if (!workspaceId || !pendingPlace) return;
    const inputDatasetId = draft.inputDatasetId.trim();
    const openClean = Boolean(inputDatasetId);
    const point = pendingPlace.point;
    const now = new Date().toISOString();
    const name = draft.name.trim() || messages.workspace.defaultTransformChipName(
      chips.filter((item) => item.kind === "transform").length + 1,
    );

    if (!openClean) {
      const chip: Chip = {
        id: `${DRAFT_CHIP_ID_PREFIX}${crypto.randomUUID()}`,
        owner_user_id: "",
        name,
        kind: "transform",
        config: {
          spec: { version: 2, sink: "parquet", steps: [] },
        },
        revision: 0,
        active: true,
        created_at: now,
        updated_at: now,
      };
      placeCatalogChips([chip], point);
      setPendingPlace(null);
      return;
    }

    void (async () => {
      try {
        if (dirtyRef.current) {
          const saved = await saveCanvas();
          if (!saved) return;
        }
        if (currentWorkspaceRef.current !== workspaceId) return;
        setBusy(true);
        let created: Chip;
        try {
          created = await chipApi.create(workspaceId, {
            name,
            kind: "transform",
            config: {
              spec: { version: 2, sink: "parquet", steps: [] },
              input_dataset_id: inputDatasetId,
            },
          });
          if (currentWorkspaceRef.current !== workspaceId) return;
          flushSync(() => {
            const nextPoint = clampPoint(point);
            const nextPositions = { ...positionsRef.current, [created.id]: nextPoint };
            const nextChips = chipsRef.current.some((chip) => chip.id === created.id)
              ? chipsRef.current
              : [created, ...chipsRef.current];
            positionsRef.current = nextPositions;
            chipsRef.current = nextChips;
            setChips(nextChips);
            setPositions(nextPositions);
            markDirty(nextChips, nextPositions, edges);
            setSelectedChipIds([created.id]);
            setSelectedEdgeIds([]);
            setPendingPlace(null);
          });
        } finally {
          if (currentWorkspaceRef.current === workspaceId) setBusy(false);
        }
        const saved = await saveCanvas();
        if (!saved || currentWorkspaceRef.current !== workspaceId) return;
        navigate(transformEditorPath(created));
      } catch (reason) {
        if (currentWorkspaceRef.current === workspaceId) {
          toastError(messages.workspace.saveChipError, reason);
        }
      }
    })();
  }

  function dropChipsLocally(chipIdsToDrop: string[]) {
    if (chipIdsToDrop.length === 0) return;
    const dropSet = new Set(chipIdsToDrop);
    const nextChips = chips.filter((item) => !dropSet.has(item.id));
    let nextPositions = positionsRef.current;
    for (const id of chipIdsToDrop) nextPositions = omitPoint(nextPositions, id);
    const nextEdges = edges.filter((edge) =>
      !dropSet.has(edge.from_chip_id) && !dropSet.has(edge.to_chip_id),
    );
    setPositions(nextPositions);
    setEdges(nextEdges);
    markDirty(nextChips, nextPositions, nextEdges);
    setChips(nextChips);
    setRuns((current) => current.filter((run) => !dropSet.has(run.chip_id)));
    if (dragRef.current && dropSet.has(dragRef.current.id)) dragRef.current = null;
    setSelectedChipIds((current) => current.filter((id) => !dropSet.has(id)));
    setSelectedEdgeIds((current) => current.filter((id) => nextEdges.some((edge) => edge.id === id)));
  }

  function removeLayersLocally(chipIdsToDrop: string[], edgeIdsToDrop: string[]) {
    if (chipIdsToDrop.length === 0 && edgeIdsToDrop.length === 0) return;
    const chipDropSet = new Set(chipIdsToDrop);
    const edgeDropSet = new Set(edgeIdsToDrop);
    const nextChips = chips.filter((item) => !chipDropSet.has(item.id));
    let nextPositions = positionsRef.current;
    for (const id of chipIdsToDrop) nextPositions = omitPoint(nextPositions, id);
    const nextEdges = edges.filter((edge) =>
      !edgeDropSet.has(edge.id)
      && !chipDropSet.has(edge.from_chip_id)
      && !chipDropSet.has(edge.to_chip_id),
    );
    setPositions(nextPositions);
    setEdges(nextEdges);
    markDirty(nextChips, nextPositions, nextEdges);
    setChips(nextChips);
    setRuns((current) => current.filter((run) => !chipDropSet.has(run.chip_id)));
    if (dragRef.current && chipDropSet.has(dragRef.current.id)) dragRef.current = null;
    setSelectedChipIds((current) => current.filter((id) => !chipDropSet.has(id)));
    setSelectedEdgeIds((current) => current.filter((id) => nextEdges.some((edge) => edge.id === id)));
  }

  function dropChipLocally(chipIdToDrop: string) {
    dropChipsLocally([chipIdToDrop]);
  }

  async function deleteCanvasChip(chip: Chip) {
    const confirmed = await showConfirm(
      messages.workspace.deleteChipTitle,
      messages.workspace.deleteChipMessage(chip.name),
      { tone: "danger", confirmLabel: messages.common.delete },
    );
    if (!confirmed || currentWorkspaceRef.current !== workspaceId) return;
    // Local draft only — workspace save unlinks chips; discard/reset restores them.
    dropChipLocally(chip.id);
    if (chipId === chip.id && workspaceId) {
      navigate(`/workspace/${workspaceId}`);
    }
  }

  async function deleteSelectedLayers() {
    const chipIds = selectedChipIdsRef.current.filter((id) =>
      chips.some((chip) => chip.id === id),
    );
    const edgeIds = selectedEdgeIdsRef.current.filter((id) =>
      edges.some((edge) => edge.id === id),
    );
    const total = chipIds.length + edgeIds.length;
    if (total === 0 || busyRef.current) return;

    if (chipIds.length === 1 && edgeIds.length === 0) {
      const chip = chips.find((item) => item.id === chipIds[0]);
      if (chip) await deleteCanvasChip(chip);
      return;
    }
    if (edgeIds.length === 1 && chipIds.length === 0) {
      await requestDeleteEdge(edgeIds[0]);
      return;
    }

    const confirmed = await showConfirm(
      messages.workspace.deleteLayersTitle,
      messages.workspace.deleteLayersMessage(chipIds.length, edgeIds.length),
      { tone: "danger", confirmLabel: messages.common.delete },
    );
    if (!confirmed || currentWorkspaceRef.current !== workspaceId) return;
    removeLayersLocally(chipIds, edgeIds);
    if (chipId && chipIds.includes(chipId) && workspaceId) {
      navigate(`/workspace/${workspaceId}`);
    }
  }

  function selectLayerChip(id: string, event: ReactMouseEvent<HTMLButtonElement>) {
    if (!workspaceId) return;
    const additive = event.ctrlKey || event.metaKey;
    if (additive) {
      const current = selectedChipIdsRef.current;
      const next = current.includes(id)
        ? current.filter((chipIdValue) => chipIdValue !== id)
        : [...current, id];
      setSelectedChipIds(next);
      if (chipId && chipId === id && !next.includes(id) && workspaceId) {
        navigate(`/workspace/${workspaceId}`);
      }
      return;
    }
    setSelectedChipIds([id]);
    setSelectedEdgeIds([]);
    if (chipId && workspaceId) navigate(`/workspace/${workspaceId}`);
  }

  function selectLayerEdge(id: string, event: ReactMouseEvent<HTMLButtonElement>) {
    if (!workspaceId) return;
    const additive = event.ctrlKey || event.metaKey;
    if (additive) {
      const current = selectedEdgeIdsRef.current;
      const next = current.includes(id)
        ? current.filter((edgeId) => edgeId !== id)
        : [...current, id];
      setSelectedEdgeIds(next);
      return;
    }
    setSelectedEdgeIds([id]);
    setSelectedChipIds([]);
    navigate(`/workspace/${workspaceId}`);
  }

  function selectAllLayers(checked: boolean) {
    if (!checked) {
      setSelectedChipIds([]);
      setSelectedEdgeIds([]);
      if (chipId && workspaceId) navigate(`/workspace/${workspaceId}`);
      return;
    }
    setSelectedChipIds(chips.map((chip) => chip.id));
    setSelectedEdgeIds(edges.map((edge) => edge.id));
  }

  async function saveCanvas(): Promise<boolean> {
    if (!workspaceId) return false;
    const requestWorkspaceId = workspaceId;
    setBusy(true);
    try {
      const currentChips = chipsRef.current;
      const draftChips = currentChips.filter((chip) => isDraftChipId(chip.id));
      const idMap = new Map<string, string>();
      let chipsToSave = [...currentChips];
      let positionsToSave = { ...positionsRef.current };
      let edgesToSave = [...edges];

      for (const draft of draftChips) {
        const created = await chipApi.create(requestWorkspaceId, {
          name: draft.name,
          kind: draft.kind,
          config: draft.config,
        });
        if (currentWorkspaceRef.current !== requestWorkspaceId) return false;
        idMap.set(draft.id, created.id);
        chipsToSave = chipsToSave.map((chip) => (chip.id === draft.id ? created : chip));
        positionsToSave[created.id] = positionsToSave[draft.id] ?? fallbackPoint(0);
        delete positionsToSave[draft.id];
      }

      if (idMap.size > 0) {
        edgesToSave = edgesToSave.map((edge) => ({
          ...edge,
          from_chip_id: idMap.get(edge.from_chip_id) ?? edge.from_chip_id,
          to_chip_id: idMap.get(edge.to_chip_id) ?? edge.to_chip_id,
        }));
        chipsRef.current = chipsToSave;
        setChips(chipsToSave);
        setEdges(edgesToSave);
        setPositions(positionsToSave);
        positionsRef.current = positionsToSave;
      }

      const response = await workspaceApi.save(requestWorkspaceId, {
        layout: {
          nodes: Object.fromEntries(
            Object.entries(positionsToSave).map(([id, point]) => [id, roundPoint(point)]),
          ),
          view: {
            x: Math.round(canvasRef.current?.scrollLeft ?? 0),
            y: Math.round(canvasRef.current?.scrollTop ?? 0),
          },
        },
        chips: chipsToSave.map((chip) => chip.id),
        edges: edgesToSave.map((edge) => {
          const fromPoint = positionsToSave[edge.from_chip_id];
          const toPoint = positionsToSave[edge.to_chip_id];
          const route = fromPoint && toPoint
            ? routeSides(fromPoint, toPoint)
            : {
              fromSide: asPortSide(edge.from_port, "right"),
              toSide: asPortSide(edge.to_port, "left"),
            };
          return {
            id: edge.id,
            from_chip_id: edge.from_chip_id,
            to_chip_id: edge.to_chip_id,
            kind: edge.kind,
            from_port: route.fromSide,
            to_port: route.toSide,
          };
        }),
      });
      if (currentWorkspaceRef.current !== requestWorkspaceId) return false;
      if (draftChips.length > 0) {
        const catalogResponse = await chipApi.listCatalog();
        if (currentWorkspaceRef.current === requestWorkspaceId) {
          setCatalogChips(catalogResponse.chips);
        }
      }
      const nextPositions = positionsFrom(response.chips, response.workspace.layout);
      const nextEdges = response.edges ?? response.workspace.edges ?? [];
      setWorkspaces((current) =>
        current.map((item) =>
          item.id === response.workspace.id ? response.workspace : item,
        ),
      );
      setChips(response.chips);
      chipsRef.current = response.chips;
      setEdges(nextEdges);
      setPositions(nextPositions);
      rememberSaved(response.chips, nextPositions, nextEdges);
      return true;
    } catch (reason) {
      if (currentWorkspaceRef.current === requestWorkspaceId) {
        toastError(messages.workspace.saveChipError, reason);
      }
      return false;
    } finally {
      if (currentWorkspaceRef.current === requestWorkspaceId) setBusy(false);
    }
  }

  async function requestSave() {
    if (!workspaceId || busy || !dirty || confirmingSaveRef.current) return;
    confirmingSaveRef.current = true;
    try {
      const confirmed = await showConfirm(
        messages.workspace.saveConfirmTitle,
        messages.workspace.saveConfirmMessage,
      );
      if (!confirmed || currentWorkspaceRef.current !== workspaceId) return;
      await saveCanvas();
    } finally {
      confirmingSaveRef.current = false;
    }
  }

  async function requestOpenWorkspace(id: string) {
    if (id && id === workspaceId) {
      setManageOpen(false);
      return;
    }
    if (dirtyRef.current) {
      const confirmed = await showConfirm(
        messages.workspace.switchConfirmTitle,
        messages.workspace.switchConfirmMessage,
        { tone: "danger", confirmLabel: messages.workspace.switchConfirmAction },
      );
      if (!confirmed) return;
    }
    setManageOpen(false);
    if (id) navigate(`/workspace/${id}`);
    else navigate("/workspace");
  }

  function resetCanvas() {
    const saved = cloneCanvas(
      savedRef.current.chips,
      savedRef.current.positions,
      savedRef.current.edges,
    );
    setChips(saved.chips);
    setEdges(saved.edges);
    setPositions(saved.positions);
    setSelectedChipIds([]);
    setSelectedEdgeIds([]);
    setDirty(false);
    if (chipId && !savedIdsRef.current.has(chipId) && workspaceId) {
      navigate(`/workspace/${workspaceId}`);
    }
  }

  async function refreshWorkspace() {
    const requestWorkspaceId = workspaceId;
    const requestId = ++refreshRequestRef.current;
    setRefreshing(true);
    try {
      const [workspaceResponse, folderResponse, datasetResponse] = await Promise.all([
        workspaceApi.list(),
        workspaceApi.listFolders(),
        datasetApi.list(),
      ]);
      if (refreshRequestRef.current !== requestId) return;
      setWorkspaces(workspaceResponse.workspaces);
      setFolders(folderResponse.folders);
      setDatasets(datasetResponse.datasets);
      if (!requestWorkspaceId) return;
      const [workspace, chipResponse, runResponse, catalogResponse] = await Promise.all([
        workspaceApi.get(requestWorkspaceId),
        chipApi.list(requestWorkspaceId),
        chipApi.listRuns(requestWorkspaceId),
        chipApi.listCatalog(),
      ]);
      if (refreshRequestRef.current !== requestId) return;
      setWorkspaces((current) => {
        const exists = current.some((item) => item.id === workspace.id);
        return exists
          ? current.map((item) => (item.id === workspace.id ? workspace : item))
          : [...current, workspace];
      });
      setRuns(runResponse.runs);
      setCatalogChips(catalogResponse.chips);
      if (dirtyRef.current) return;
      const nextPositions = positionsFrom(chipResponse.chips, workspace.layout);
      const nextEdges = workspace.edges ?? [];
      pendingViewRef.current = workspace.layout.view ?? { x: 0, y: 0 };
      setChips(chipResponse.chips);
      setEdges(nextEdges);
      setPositions(nextPositions);
      rememberSaved(chipResponse.chips, nextPositions, nextEdges);
    } catch (reason) {
      if (refreshRequestRef.current === requestId) {
        toastError(messages.workspace.loadError, reason);
      }
    } finally {
      if (refreshRequestRef.current === requestId) setRefreshing(false);
    }
  }

  requestSaveRef.current = () => {
    void requestSave();
  };
  resetCanvasRef.current = resetCanvas;

  function onToolDragStart(kindValue: "extract" | "transform", event: DragEvent<HTMLButtonElement>) {
    event.dataTransfer.setData(TOOL_KIND, kindValue);
    event.dataTransfer.effectAllowed = "copy";
    const ghost = document.createElement("div");
    ghost.className = "dock-drag-ghost";
    const icon = event.currentTarget.querySelector("svg");
    if (icon) ghost.appendChild(icon.cloneNode(true));
    document.body.appendChild(ghost);
    event.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
    dragGhostRef.current?.remove();
    dragGhostRef.current = ghost;
  }

  function onToolDragEnd() {
    dragGhostRef.current?.remove();
    dragGhostRef.current = null;
  }

  function onCanvasDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const grab = canvasPoint(canvas, event.clientX, event.clientY);
    const point = { x: grab.x - NODE_W / 2, y: grab.y - NODE_H / 2 };
    const toolKind = event.dataTransfer.getData(TOOL_KIND);
    if (toolKind !== "extract" && toolKind !== "transform") return;
    placeTool(toolKind, point);
  }

  function onNodePointerDown(chip: Chip, event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".chip-link, button")) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const node = positionsRef.current[chip.id] ?? { x: 56, y: 48 };
    const grab = canvasPoint(canvas, event.clientX, event.clientY);
    const additive = event.ctrlKey || event.metaKey;
    const wasSelected = selectedChipIdsRef.current.includes(chip.id);
    if (!additive && !wasSelected) {
      setSelectedChipIds([chip.id]);
      setSelectedEdgeIds([]);
    } else if (!wasSelected) {
      setSelectedChipIds([...selectedChipIdsRef.current, chip.id]);
    }
    const dragIds = wasSelected
      ? selectedChipIdsRef.current
      : additive
        ? [...new Set([...selectedChipIdsRef.current, chip.id])]
        : [chip.id];
    const origins: Record<string, Point> = {};
    for (const id of dragIds) {
      origins[id] = positionsRef.current[id] ?? { x: 56, y: 48 };
    }
    dragRef.current = {
      id: chip.id,
      dx: grab.x - node.x,
      dy: grab.y - node.y,
      startX: node.x,
      startY: node.y,
      moved: false,
      additive,
      wasSelected,
      origins,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function finishNodeDrag(draggedChipId: string, openInspector: boolean) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.id !== draggedChipId) return;
    if (drag.moved) {
      markDirty(chips, positionsRef.current, edges);
      return;
    }
    if (drag.additive) {
      if (drag.wasSelected) {
        const next = selectedChipIdsRef.current.filter((id) => id !== draggedChipId);
        setSelectedChipIds(next);
        if (!workspaceId) return;
        if (chipId === draggedChipId && !next.includes(draggedChipId)) {
          navigate(`/workspace/${workspaceId}`);
        }
      } else if (workspaceId && chipId) {
        navigate(`/workspace/${workspaceId}`);
      }
      return;
    }
    if (!openInspector || !workspaceId) return;
    setSelectedChipIds([draggedChipId]);
    setSelectedEdgeIds([]);
    if (chipId) navigate(`/workspace/${workspaceId}`);
  }

  function onNodePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const canvas = canvasRef.current;
    if (!drag || !canvas || drag.id !== event.currentTarget.dataset.chipId) return;
    if (pointerOutsideCanvas(canvas, event.clientX, event.clientY)) {
      releasePointer(event.currentTarget, event.pointerId);
      finishNodeDrag(drag.id, false);
      return;
    }
    scrollCanvasFromPointer(canvas, event.clientX, event.clientY);
    const grab = canvasPoint(canvas, event.clientX, event.clientY);
    const tentative = { x: grab.x - drag.dx, y: grab.y - drag.dy };
    const nextPrimary = clampPoint(tentative);
    const deltaX = nextPrimary.x - drag.startX;
    const deltaY = nextPrimary.y - drag.startY;
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) drag.moved = true;
    setPositions((current) => {
      const next = { ...current };
      for (const [id, origin] of Object.entries(drag.origins)) {
        next[id] = clampPoint({ x: origin.x + deltaX, y: origin.y + deltaY });
      }
      return next;
    });
  }

  function onNodePointerUp(chip: Chip) {
    finishNodeDrag(chip.id, true);
  }

  function onNodePointerCancel(chip: Chip, event: ReactPointerEvent<HTMLDivElement>) {
    releasePointer(event.currentTarget, event.pointerId);
    finishNodeDrag(chip.id, false);
  }

  function onPortPointerDown(
    chip: Chip,
    side: PortSide,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const grab = canvasPoint(canvas, event.clientX, event.clientY);
    const kindValue = edgeTool;
    setSelectedEdgeIds([]);
    setLinking({ fromId: chip.id, kind: kindValue, fromSide: side, x: grab.x, y: grab.y });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPortPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!linkingRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (pointerOutsideCanvas(canvas, event.clientX, event.clientY)) {
      releasePointer(event.currentTarget, event.pointerId);
      setLinking(null);
      return;
    }
    scrollCanvasFromPointer(canvas, event.clientX, event.clientY);
    const grab = canvasPoint(canvas, event.clientX, event.clientY);
    setLinking((current) => current ? { ...current, x: grab.x, y: grab.y } : current);
  }

  function onPortPointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    const link = linkingRef.current;
    setLinking(null);
    if (!link) return;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const host = target instanceof Element ? target.closest("[data-chip-id]") : null;
    const toId = host instanceof HTMLElement ? host.dataset.chipId : undefined;
    if (toId) void connectChips(link.fromId, toId, link.kind);
  }

  function onPortPointerCancel(event: ReactPointerEvent<HTMLButtonElement>) {
    releasePointer(event.currentTarget, event.pointerId);
    setLinking(null);
  }

  function cancelCanvasGesture(pointerId: number) {
    const canvas = canvasRef.current;
    if (canvas) releasePointer(canvas, pointerId);
    panRef.current = null;
    marqueeRef.current = null;
    setMarquee(null);
  }

  function finishMarqueeSelection() {
    const box = marqueeRef.current;
    marqueeRef.current = null;
    setMarquee(null);
    if (!box) return;
    if (!box.moved) {
      setSelectedEdgeIds([]);
      setSelectedChipIds([]);
      if (chipId && workspaceId) navigate(`/workspace/${workspaceId}`, { replace: true });
      return;
    }
    const positions = positionsRef.current;
    const pickedChips = chips
      .filter((chip) => {
        const point = positions[chip.id];
        return point ? chipInMarquee(point, box) : false;
      })
      .map((chip) => chip.id);
    const pickedEdges = edges
      .filter((edge) => {
        const from = positions[edge.from_chip_id];
        const to = positions[edge.to_chip_id];
        return from && to ? edgeInMarquee(from, to, box) : false;
      })
      .map((edge) => edge.id);
    setSelectedChipIds(
      box.additive
        ? [...new Set([...selectedChipIdsRef.current, ...pickedChips])]
        : pickedChips,
    );
    setSelectedEdgeIds(
      box.additive
        ? [...new Set([...selectedEdgeIdsRef.current, ...pickedEdges])]
        : pickedEdges,
    );
    if (chipId && workspaceId) navigate(`/workspace/${workspaceId}`);
  }

  function onCanvasPanDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 && event.button !== 1) return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-chip-id], .chip-link, button, .chip-wire")) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (event.button === 1) {
      panRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        scrollLeft: canvas.scrollLeft,
        scrollTop: canvas.scrollTop,
        moved: false,
      };
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

    const grab = clampMarqueePoint(canvasPoint(canvas, event.clientX, event.clientY));
    marqueeRef.current = {
      pointerId: event.pointerId,
      x0: grab.x,
      y0: grab.y,
      x1: grab.x,
      y1: grab.y,
      moved: false,
      additive: event.ctrlKey || event.metaKey,
    };
    setMarquee({ x0: grab.x, y0: grab.y, x1: grab.x, y1: grab.y });
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function onCanvasPanMove(event: ReactPointerEvent<HTMLDivElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const pan = panRef.current;
    const box = marqueeRef.current;

    if (pan && pan.pointerId === event.pointerId) {
      const dx = event.clientX - pan.startX;
      const dy = event.clientY - pan.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) pan.moved = true;
      canvas.scrollLeft = pan.scrollLeft - dx;
      canvas.scrollTop = pan.scrollTop - dy;
      return;
    }

    if (!box || box.pointerId !== event.pointerId) return;
    // Keep the marquee alive outside the viewport: clamp to the canvas world
    // and auto-scroll so the selection can reach the far edge.
    scrollCanvasFromPointer(canvas, event.clientX, event.clientY);
    const grab = clampMarqueePoint(canvasPoint(canvas, event.clientX, event.clientY));
    if (Math.abs(grab.x - box.x0) > 3 || Math.abs(grab.y - box.y0) > 3) box.moved = true;
    box.x1 = grab.x;
    box.y1 = grab.y;
    setMarquee({ x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 });
  }

  function onCanvasPanUp(event: ReactPointerEvent<HTMLDivElement>) {
    const pan = panRef.current;
    if (pan && pan.pointerId === event.pointerId) {
      panRef.current = null;
      if (!pan.moved && workspaceId) {
        setSelectedEdgeIds([]);
        setSelectedChipIds([]);
        if (chipId) navigate(`/workspace/${workspaceId}`, { replace: true });
      }
      return;
    }

    if (!marqueeRef.current || marqueeRef.current.pointerId !== event.pointerId) return;
    finishMarqueeSelection();
  }

  function onCanvasPanCancel(event: ReactPointerEvent<HTMLDivElement>) {
    cancelCanvasGesture(event.pointerId);
  }

  function jumpCanvasTo(worldX: number, worldY: number) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.scrollTo({
      left: Math.max(0, worldX - canvas.clientWidth / 2),
      top: Math.max(0, worldY - canvas.clientHeight / 2),
    });
  }

  const focusChip = useMemo(() => {
    if (selectedChipIds.length !== 1) return null;
    return chips.find((chip) => chip.id === selectedChipIds[0]) ?? null;
  }, [chips, selectedChipIds]);
  const latestByChip = useMemo(() => {
    const map = new Map<string, ChipRun>();
    for (const run of runs) {
      if (!map.has(run.chip_id)) map.set(run.chip_id, run);
    }
    return map;
  }, [runs]);

  const tools = [
    {
      kind: "extract" as const,
      label: messages.workspace.extract,
      hint: messages.workspace.extractHint,
      icon: DatabaseZap,
    },
    {
      kind: "transform" as const,
      label: messages.workspace.transform,
      hint: messages.workspace.transformHint,
      icon: Workflow,
    },
  ];
  const edgeTools = [
    {
      kind: "data" as const,
      label: messages.workspace.edgeData,
      hint: messages.workspace.edgeDataHint,
      icon: Spline,
    },
    {
      kind: "on_success" as const,
      label: messages.workspace.edgeOnSuccess,
      hint: messages.workspace.edgeOnSuccessHint,
      icon: CheckCircle2,
    },
    {
      kind: "on_error" as const,
      label: messages.workspace.edgeOnError,
      hint: messages.workspace.edgeOnErrorHint,
      icon: CircleAlert,
    },
    {
      kind: "always" as const,
      label: messages.workspace.edgeAlways,
      hint: messages.workspace.edgeAlwaysHint,
      icon: ArrowRight,
    },
  ];

  return (
    <>
    <SplitLayout
      reverse
      className="h-full min-h-0 bg-canvas"
      defaultSizes={[layout.split.sidebar + 80]}
    >
      <aside className="workspace-rail flex h-full min-h-0 flex-col overflow-hidden">
        <section className="workspace-rail-card flex h-full min-h-0 flex-col overflow-hidden">
          <SplitLayout
            direction="vertical"
            className="workspace-rail-split min-h-0 flex-1"
            defaultSizes={[238]}
            minSize={layout.split.minStack}
            insetGutter
          >
            <div className="scroll-pane min-h-0 flex-1 overflow-y-auto p-3 pb-2">
              <WorkspaceBrowserPanel
                messages={messages}
                folderPath={workspaceFolderPath}
                workspaceName={workspaceName}
                onManage={() => setManageOpen(true)}
              />
            </div>

            <div className="scroll-pane min-h-0 flex-1 overflow-y-auto p-3 pt-2">
              <WorkspaceLayers
                chips={chips}
                edges={edges}
                selectedChipIds={selectedChipIds}
                selectedEdgeIds={selectedEdgeIds}
                messages={messages}
                emptyHint={workspaceId ? messages.workspace.emptyLayers : messages.workspace.noWorkspaces}
                open={layersOpen}
                onToggle={() => setLayersOpen((current) => !current)}
                onSelectChip={selectLayerChip}
                onSelectEdge={selectLayerEdge}
                onSelectAll={selectAllLayers}
                onDeleteSelected={() => void deleteSelectedLayers()}
                onEditChip={(chip) => {
                  setSelectedChipIds([chip.id]);
                  openChipProperties(chip);
                }}
              />
            </div>
          </SplitLayout>

          {workspaceId ? (
              <div className="workspace-rail-card-foot grid shrink-0 grid-cols-2 items-center gap-2">
                <span className="col-start-2 justify-self-end rounded-full border border-border bg-subtle/70 px-2.5 py-1 text-[11px] font-semibold tabular-nums text-text-secondary">
                  {messages.workspace.version(selectedWorkspace?.version ?? 1)}
                  {dirty ? ` · ${messages.workspace.unsaved}` : ""}
                </span>
                <Button
                  type="button"
                  className="w-full gap-2"
                  disabled={busy || dirty || chips.length === 0}
                  title={dirty ? messages.workspace.saveFirst : messages.workspace.runChip}
                  onClick={() => void runWorkspace()}
                >
                  <Play className="size-3.5" aria-hidden="true" />
                  {busy ? messages.common.running : messages.workspace.runChip}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  className="w-full gap-2"
                  disabled={busy || !dirty}
                  onClick={() => void requestSave()}
                >
                  <Save className="size-3.5" aria-hidden="true" />
                  {busy ? messages.common.saving : messages.workspace.saveCanvas}
                </Button>
              </div>
            ) : null}
        </section>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="relative shrink-0 overflow-hidden border-b border-accent/15 bg-gradient-to-r from-surface from-[12%] to-accent-subtle px-4 py-2.5">
          <div className="pointer-events-none absolute -right-10 -top-12 size-36 rounded-full bg-accent/20 blur-2xl" />
          <div className="pointer-events-none absolute right-24 -bottom-14 size-24 rounded-full bg-surface/70 blur-xl" />
          <div className="relative flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <span
                className={cn(
                  "flex h-8 w-10 shrink-0 items-center border-r border-border pr-3",
                  focusChip
                    ? focusChip.kind === "extract"
                      ? "text-accent"
                      : "text-success"
                    : "text-text",
                )}
              >
                {focusChip ? (
                  focusChip.kind === "transform" ? (
                    <Workflow className="size-[22px]" aria-hidden="true" />
                  ) : (
                    <DatabaseZap className="size-[22px]" aria-hidden="true" />
                  )
                ) : (
                  <FolderOpen className="size-[22px]" aria-hidden="true" />
                )}
              </span>
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
                  {messages.workspace.title}
                </p>
                <h1 className="mt-0.5 min-w-0 truncate text-sm font-semibold tracking-[-0.015em] text-text">
                  {focusChip?.name ?? selectedWorkspace?.name ?? messages.workspace.selectWorkspace}
                </h1>
              </div>
            </div>
            <ul className="flex shrink-0 items-center gap-2">
              <li className="hidden text-[11px] text-text-tertiary sm:block">
                {messages.workspace.chipContextHint}
              </li>
              <ShortcutHint keys={["Ctrl", "S"]} label={messages.workspace.shortcutSave} />
              <ShortcutHint keys={["Ctrl", "Z"]} label={messages.workspace.shortcutReset} />
            </ul>
          </div>
        </header>
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <nav
          aria-label={messages.workspace.toolsAria}
          className="pointer-events-none absolute left-5 top-7 z-20"
        >
          <ul className="dock-rail pointer-events-auto">
            {tools.map((tool) => (
              <ToolIconButton
                key={tool.kind}
                label={tool.label}
                hint={tool.hint}
                icon={tool.icon}
                draggable
                disabled={busy || refreshing || !workspaceId}
                onDragStart={(event) => onToolDragStart(tool.kind, event)}
                onDragEnd={onToolDragEnd}
              />
            ))}
            {edgeTools.map((tool, index) => (
              <ToolIconButton
                key={tool.kind}
                label={tool.label}
                hint={tool.hint}
                icon={tool.icon}
                separate={index === 0}
                pressed={edgeTool === tool.kind}
                disabled={busy || refreshing || !workspaceId}
                onClick={() => setEdgeTool(tool.kind)}
              />
            ))}
            <ToolIconButton
              label={messages.common.refresh}
              hint={messages.workspace.refreshHint}
              icon={RefreshCw}
              spinning={refreshing}
              disabled={busy || refreshing}
              onClick={() => void refreshWorkspace()}
            />
          </ul>
        </nav>
        {chips.length === 0 && workspaceId ? (
          <p className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-sm text-text-tertiary">
            {loading ? messages.common.loading : messages.workspace.canvasHint}
          </p>
        ) : null}
        <section
          ref={canvasRef}
          role="application"
          aria-label={messages.workspace.canvasAria}
          className="workspace-canvas relative h-full min-h-0 min-w-0 cursor-crosshair overflow-auto overscroll-contain"
          onDragOver={(event) => event.preventDefault()}
          onDrop={onCanvasDrop}
          onPointerDown={onCanvasPanDown}
          onPointerMove={onCanvasPanMove}
          onPointerUp={onCanvasPanUp}
          onPointerCancel={onCanvasPanCancel}
          onLostPointerCapture={(event) => {
            if (panRef.current?.pointerId === event.pointerId) {
              panRef.current = null;
              return;
            }
            // Capture can drop without a reliable pointerup (browser/OS). Finish
            // the marquee so a partial drag still selects instead of vanishing.
            if (marqueeRef.current?.pointerId === event.pointerId) {
              finishMarqueeSelection();
            }
          }}
        >
          <div
            className="relative"
            style={{
              width: canvasWorld.width,
              height: canvasWorld.height,
              backgroundImage: "radial-gradient(circle, var(--theme-canvas-dot) 1px, transparent 1.5px)",
              backgroundSize: "22px 22px",
            }}
          >
        <svg
          className="pointer-events-none absolute inset-0"
          width={canvasWorld.width}
          height={canvasWorld.height}
        >
          <defs>
            {(["data", "on_success", "on_error", "always"] as const).map((kindValue) => (
              <marker
                key={kindValue}
                id={`chip-wire-arrow-${kindValue}`}
                markerWidth="12"
                markerHeight="10"
                refX="10"
                refY="5"
                orient="auto"
                markerUnits="userSpaceOnUse"
              >
                <path
                  className={cn("chip-wire-arrow", wireTone(kindValue))}
                  d="M 1 1 L 10 5 L 1 9"
                />
              </marker>
            ))}
          </defs>
          {edges.map((edge) => {
            const from = positions[edge.from_chip_id];
            const to = positions[edge.to_chip_id];
            if (!from || !to) return null;
            return (
              <EdgeWire
                key={edge.id}
                geo={edgeGeometry(from, to)}
                kind={edge.kind}
                selected={selectedEdgeIds.includes(edge.id)}
                onClick={(event) => {
                  event.stopPropagation();
                  const additive = event.ctrlKey || event.metaKey;
                  if (additive) {
                    const current = selectedEdgeIdsRef.current;
                    setSelectedEdgeIds(current.includes(edge.id)
                      ? current.filter((id) => id !== edge.id)
                      : [...current, edge.id]);
                  } else {
                    setSelectedEdgeIds([edge.id]);
                    setSelectedChipIds([]);
                  }
                  if (workspaceId) navigate(`/workspace/${workspaceId}`);
                }}
              />
            );
          })}
          {linking ? (() => {
            const from = positions[linking.fromId];
            if (!from) return null;
            return (
              <EdgeWire
                geo={previewGeometry(from, { x: linking.x, y: linking.y }, linking.fromSide)}
                kind={linking.kind}
                preview
              />
            );
          })() : null}
        </svg>
        {chips.map((chip) => {
          const point = positions[chip.id] ?? fallbackPoint(0);
          const latest = latestByChip.get(chip.id);
          const Icon = chip.kind === "transform" ? Workflow : DatabaseZap;
          return (
            <div
              key={chip.id}
              role="button"
              tabIndex={0}
              data-chip-id={chip.id}
              aria-current={selectedChipIds.includes(chip.id) ? "true" : undefined}
              aria-label={chip.name}
              className={cn(
                "workspace-node absolute flex h-[96px] w-[100px] cursor-grab select-none flex-col items-center gap-0.5 px-1.5 pb-1.5 pt-4 text-center active:cursor-grabbing",
                selectedChipIds.includes(chip.id) && "is-selected",
              )}
              style={{ left: point.x, top: point.y }}
              onPointerDown={(event) => onNodePointerDown(chip, event)}
              onPointerMove={onNodePointerMove}
              onPointerUp={() => onNodePointerUp(chip)}
              onPointerCancel={(event) => onNodePointerCancel(chip, event)}
              onLostPointerCapture={() => {
                if (dragRef.current?.id === chip.id) finishNodeDrag(chip.id, false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedChipIds([chip.id]);
                  setSelectedEdgeIds([]);
                }
              }}
              onDoubleClick={(event) => {
                if ((event.target as HTMLElement).closest(".chip-link, button")) return;
                event.preventDefault();
                event.stopPropagation();
                setSelectedChipIds([chip.id]);
                setSelectedEdgeIds([]);
                setInfoChip(chip);
              }}
              onContextMenu={(event) => openChipContextMenu(chip, event)}
            >
              <ChipLinkHandle
                side="left"
                label={messages.workspace.connectChip}
                kind={edgeTool}
                onPointerDown={(event) => onPortPointerDown(chip, "left", event)}
                onPointerMove={onPortPointerMove}
                onPointerUp={onPortPointerUp}
                onPointerCancel={onPortPointerCancel}
              />
              <ChipLinkHandle
                side="right"
                label={messages.workspace.connectChip}
                kind={edgeTool}
                onPointerDown={(event) => onPortPointerDown(chip, "right", event)}
                onPointerMove={onPortPointerMove}
                onPointerUp={onPortPointerUp}
                onPointerCancel={onPortPointerCancel}
              />
              <ChipLinkHandle
                side="top"
                label={messages.workspace.connectChip}
                kind={edgeTool}
                onPointerDown={(event) => onPortPointerDown(chip, "top", event)}
                onPointerMove={onPortPointerMove}
                onPointerUp={onPortPointerUp}
                onPointerCancel={onPortPointerCancel}
              />
              <ChipLinkHandle
                side="bottom"
                label={messages.workspace.connectChip}
                kind={edgeTool}
                onPointerDown={(event) => onPortPointerDown(chip, "bottom", event)}
                onPointerMove={onPortPointerMove}
                onPointerUp={onPortPointerUp}
                onPointerCancel={onPortPointerCancel}
              />
              <button
                type="button"
                className="absolute right-0.5 top-0.5 z-10 grid size-4 place-items-center rounded text-text-tertiary outline-none hover:bg-danger-subtle hover:text-danger focus-visible:ring-2 focus-visible:ring-accent/40"
                aria-label={messages.common.delete}
                title={messages.common.delete}
                disabled={busy}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  event.preventDefault();
                }}
                onPointerUp={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  void deleteCanvasChip(chip);
                }}
              >
                <X className="size-3" aria-hidden="true" />
              </button>
              <span className={cn(
                "workspace-node-icon",
                chip.kind === "extract" ? "is-extract" : "is-transform",
              )}>
                <Icon aria-hidden="true" />
              </span>
              <span className="w-full truncate text-[11px] font-semibold leading-tight text-text">{chip.name}</span>
              <span className="text-[9px] font-medium uppercase tracking-wide text-text-tertiary">
                {chip.kind === "extract" ? messages.workspace.extract : messages.workspace.transform}
              </span>
              <span className="mt-auto flex h-4 scale-90 items-center justify-center">
                {latest ? (
                  <StatusPill value={latest.status} />
                ) : (
                  <span className="text-[9px] font-medium text-text-tertiary">
                    {chip.output?.available
                      ? messages.workspace.outputReady
                      : messages.workspace.outputEmpty}
                  </span>
                )}
              </span>
            </div>
          );
        })}
            {marquee ? (() => {
              const area = normalizeMarquee(marquee);
              return (
                <div
                  className="workspace-marquee pointer-events-none absolute z-20"
                  style={{
                    left: area.x,
                    top: area.y,
                    width: area.w,
                    height: area.h,
                  }}
                />
              );
            })() : null}
          </div>
        </section>
        {workspaceId ? (
          <WorkspaceMinimap
            chips={chips}
            positions={positions}
            scroll={canvasScroll}
            view={canvasView}
            label={messages.workspace.minimapAria}
            onJump={jumpCanvasTo}
          />
        ) : null}
        </div>
      </div>
    </SplitLayout>

      <ChipPlaceDialog
        open={Boolean(pendingPlace)}
        kind={pendingPlace?.kind ?? "extract"}
        catalogChips={catalogChips}
        datasets={datasets}
        canvasChipIds={new Set(chips.map((chip) => chip.id))}
        defaultTransformIndex={chips.filter((chip) => chip.kind === "transform").length + 1}
        messages={messages}
        busy={busy}
        onClose={cancelPlaceChip}
        onPlaceCatalog={confirmCatalogChips}
        onPlaceNewTransform={(draft) => placeNewTransformChip(draft)}
      />

      <ChipContextMenu
        menu={chipMenu}
        messages={messages}
        busy={busy}
        onClose={() => setChipMenu(null)}
        onRun={(chip) => void runSingleChip(chip)}
        onInfo={setInfoChip}
        onProperties={openChipProperties}
        onEdit={openTransformEditor}
        onDelete={(chip) => void deleteCanvasChip(chip)}
      />

      <AppDialog
        open={Boolean(infoChip)}
        title={infoChip?.name ?? ""}
        icon={
          <Puzzle
            className={cn("size-4", infoChip?.kind === "transform" ? "text-success" : "text-accent")}
            aria-hidden="true"
          />
        }
        onClose={() => setInfoChip(null)}
        className="w-[min(40rem,94vw)]"
        minWidth={380}
        minHeight={320}
        headerExtra={
          <div className="flex flex-1 justify-end">
            <button
              type="button"
              className="grid size-8 shrink-0 place-items-center rounded-lg text-text-secondary outline-none transition-colors hover:bg-subtle hover:text-text focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45"
              aria-label={messages.common.edit}
              title={`${messages.common.edit} (${messages.common.comingSoon})`}
              disabled
            >
              <Pencil className="size-4" aria-hidden="true" />
            </button>
          </div>
        }
      >
        {infoChip ? (
          <div className="flex flex-col gap-4 p-4">
            <dl className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <dt className="text-text-tertiary">{messages.workspace.chipName}</dt>
                <dd className="mt-1 font-medium text-text">{infoChip.name}</dd>
              </div>
              <div>
                <dt className="text-text-tertiary">{messages.chips.headers[2]}</dt>
                <dd className="mt-1 font-medium text-text">
                  {chipKindLabel(infoChip.kind, messages)}
                </dd>
              </div>
            </dl>
            <ChipDetailView chip={infoChip} />
          </div>
        ) : null}
      </AppDialog>

      <AppDialog
        open={Boolean(propsChip)}
        title={messages.workspace.chipPropertiesTitle}
        onClose={() => setPropsChip(null)}
        className="w-[min(24rem,92vw)]"
        footer={
          <>
            <Button type="button" variant="quiet" disabled={propsBusy} onClick={() => setPropsChip(null)}>
              {messages.common.cancel}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={propsBusy || !propsName.trim()}
              onClick={() => void saveChipProperties()}
            >
              {propsBusy ? messages.common.saving : messages.workspace.chipPropertiesSave}
            </Button>
          </>
        }
      >
        <div className="p-1">
          <FormField label={messages.workspace.chipName}>
            <input
              className="field-control text-sm"
              value={propsName}
              onChange={(event) => setPropsName(event.target.value)}
              autoFocus
            />
          </FormField>
        </div>
      </AppDialog>

      <WorkspaceManageDialog
        open={manageOpen}
        folders={folders}
        workspaces={workspaces}
        focusFolderId={selectedWorkspace?.folder_id ?? null}
        currentWorkspaceId={workspaceId}
        onClose={() => setManageOpen(false)}
        onFoldersChange={setFolders}
        onWorkspacesChange={setWorkspaces}
        onOpenWorkspace={(id) => {
          void requestOpenWorkspace(id);
        }}
      />
    </>
  );
}
