import { DragEvent, FormEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { DatabaseZap, FolderOpen, RefreshCw, RotateCcw, Save, Workflow, X, type LucideIcon } from "lucide-react";
import { SplitLayout } from "@/components/SplitLayout";
import { StatusPill } from "@/components/StatusPill";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { fmtWhen } from "@/lib/format";
import { layout } from "@/lib/layout";
import { showConfirm } from "@/lib/notifications";
import { connectionApi } from "@/services/connectionApi";
import { datasetApi } from "@/services/datasetApi";
import { taskApi } from "@/services/taskApi";
import { workspaceApi } from "@/services/workspaceApi";
import type { DataConnection } from "@/types/connection";
import type { Dataset } from "@/types/dataset";
import type { TaskConfig, TaskDefinition, TaskKind, TaskRun } from "@/types/task";
import type { Workspace, WorkspaceLayout } from "@/types/workspace";

const EMPTY_SPEC = JSON.stringify(
  { version: 2, sink: "parquet", steps: [] },
  null,
  2,
);
const ACTIVE_STATUSES = new Set(["queued", "running"]);
const TOOL_KIND = "application/x-bintl-tool";
const NODE_W = 128;
const NODE_H = 120;
const CANVAS_MIN_W = 2400;
const CANVAS_MIN_H = 1600;
const CANVAS_PAD = 280;
const CANVAS_EDGE = 56;
const CANVAS_SCROLL_STEP = 18;

type Point = { x: number; y: number };
type CanvasSnapshot = { tasks: TaskDefinition[]; positions: Record<string, Point> };

function cloneCanvas(tasks: TaskDefinition[], positions: Record<string, Point>): CanvasSnapshot {
  return JSON.parse(JSON.stringify({ tasks, positions })) as CanvasSnapshot;
}

function textValue(config: TaskConfig, key: string, fallback = ""): string {
  return typeof config[key] === "string" ? config[key] as string : fallback;
}

function boolValue(config: TaskConfig, key: string, fallback: boolean): boolean {
  return typeof config[key] === "boolean" ? config[key] as boolean : fallback;
}

function objectValue(config: TaskConfig, key: string): TaskConfig {
  const value = config[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as TaskConfig
    : {};
}

function nodesFromLayout(layout?: WorkspaceLayout): Record<string, Point> {
  return layout?.nodes ?? {};
}

function draftConfig(kind: "extract" | "transform"): TaskConfig {
  if (kind === "extract") {
    return {
      connection_id: "",
      source: { type: "table", table: "" },
      delimiter: ",",
      header: true,
    };
  }
  return { spec: { version: 2, sink: "parquet", steps: [] } };
}

function fallbackPoint(index: number): Point {
  return { x: 112 + (index % 4) * 156, y: 40 + Math.floor(index / 4) * 132 };
}

function clampPoint(point: Point, bounds: { width: number; height: number }): Point {
  return {
    x: Math.max(16, Math.min(point.x, Math.max(16, bounds.width - NODE_W - 16))),
    y: Math.max(16, Math.min(point.y, Math.max(16, bounds.height - NODE_H - 16))),
  };
}

function canvasPoint(canvas: HTMLElement, clientX: number, clientY: number): Point {
  const rect = canvas.getBoundingClientRect();
  return {
    x: clientX - rect.left + canvas.scrollLeft,
    y: clientY - rect.top + canvas.scrollTop,
  };
}

function worldSize(
  positions: Record<string, Point>,
  viewport: { width: number; height: number },
): { width: number; height: number } {
  let maxX = 0;
  let maxY = 0;
  for (const point of Object.values(positions)) {
    maxX = Math.max(maxX, point.x + NODE_W);
    maxY = Math.max(maxY, point.y + NODE_H);
  }
  return {
    width: Math.max(CANVAS_MIN_W, viewport.width, maxX + CANVAS_PAD),
    height: Math.max(CANVAS_MIN_H, viewport.height, maxY + CANVAS_PAD),
  };
}

function roundPoint(point: Point): Point {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

function scrollCanvasFromPointer(canvas: HTMLElement, clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect();
  let dx = 0;
  let dy = 0;
  if (clientX > rect.right - CANVAS_EDGE) dx = CANVAS_SCROLL_STEP;
  else if (clientX < rect.left + CANVAS_EDGE) dx = -CANVAS_SCROLL_STEP;
  if (clientY > rect.bottom - CANVAS_EDGE) dy = CANVAS_SCROLL_STEP;
  else if (clientY < rect.top + CANVAS_EDGE) dy = -CANVAS_SCROLL_STEP;
  if (dx !== 0) canvas.scrollLeft += dx;
  if (dy !== 0) canvas.scrollTop += dy;
}

function omitPoint(positions: Record<string, Point>, id: string): Record<string, Point> {
  const next = { ...positions };
  delete next[id];
  return next;
}

function ShortcutHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <li className="flex items-center gap-1.5" aria-label={`${keys.join("+")} ${label}`}>
      <span className="inline-flex items-center gap-0.5" aria-hidden="true">
        {keys.map((key, index) => (
          <span key={`${index}-${key}`} className="inline-flex items-center gap-0.5">
            {index > 0 ? <span className="text-[10px] text-text-tertiary">+</span> : null}
            <kbd className="rounded border border-border bg-surface px-1.5 py-px text-[10px] font-semibold leading-5 text-text shadow-[inset_0_-1px_0_var(--color-border-strong)]">
              {key}
            </kbd>
          </span>
        ))}
      </span>
      <span className="text-[11px] text-text-secondary">{label}</span>
    </li>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function ToolIconButton({
  label,
  hint,
  icon: Icon,
  disabled,
  spinning,
  draggable = false,
  onDragStart,
  onDragEnd,
  onClick,
}: {
  label: string;
  hint: string;
  icon: LucideIcon;
  disabled?: boolean;
  spinning?: boolean;
  draggable?: boolean;
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd?: () => void;
  onClick?: () => void;
}) {
  const [tipOpen, setTipOpen] = useState(false);

  return (
    <li
      className="relative"
      onMouseEnter={() => setTipOpen(true)}
      onMouseLeave={() => setTipOpen(false)}
    >
      <button
        type="button"
        draggable={draggable && !disabled}
        disabled={disabled}
        aria-label={`${label}. ${hint}`}
        className="dock-btn"
        onDragStart={(event) => {
          setTipOpen(false);
          onDragStart?.(event);
        }}
        onDragEnd={onDragEnd}
        onClick={(event) => {
          setTipOpen(false);
          event.currentTarget.blur();
          onClick?.();
        }}
      >
        <Icon className={cn(spinning && "animate-spin")} aria-hidden="true" />
      </button>
      <div role="tooltip" className={cn("dock-tip", tipOpen && "is-open")}>
        <p className="text-xs font-semibold text-text">{label}</p>
        <p className="mt-0.5 text-[11px] leading-4 text-text-secondary">{hint}</p>
      </div>
    </li>
  );
}

export function WorkspacePage() {
  const { messages } = useLanguage();
  const navigate = useNavigate();
  const { workspaceId, taskId } = useParams<{ workspaceId: string; taskId: string }>();
  const currentWorkspaceRef = useRef(workspaceId);
  const logRequestRef = useRef(0);
  const refreshRequestRef = useRef(0);
  const canvasRef = useRef<HTMLDivElement>(null);
  const pendingViewRef = useRef<Point | null>(null);
  const positionsRef = useRef<Record<string, Point>>({});
  const savedRef = useRef<CanvasSnapshot>({ tasks: [], positions: {} });
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
  } | null>(null);
  currentWorkspaceRef.current = workspaceId;

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [tasks, setTasks] = useState<TaskDefinition[]>([]);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [connections, setConnections] = useState<DataConnection[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loadingLogId, setLoadingLogId] = useState<string | null>(null);
  const [runLog, setRunLog] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [canvasView, setCanvasView] = useState({ width: 800, height: 600 });

  const [name, setName] = useState("");
  const [kind, setKind] = useState<TaskKind>("extract");
  const [mode, setMode] = useState("table");
  const [connectionId, setConnectionId] = useState("");
  const [database, setDatabase] = useState("");
  const [table, setTable] = useState("");
  const [sql, setSql] = useState("");
  const [delimiter, setDelimiter] = useState(",");
  const [hasHeader, setHasHeader] = useState(true);
  const [inputDatasetId, setInputDatasetId] = useState("");
  const [spec, setSpec] = useState(EMPTY_SPEC);
  positionsRef.current = positions;
  dirtyRef.current = dirty;
  busyRef.current = busy;

  const selectedWorkspace = workspaces.find((item) => item.id === workspaceId);
  const selectedTask = tasks.find(
    (item) => item.id === taskId && item.workspace_id === workspaceId,
  );
  const hasActiveRun = runs.some((run) => ACTIVE_STATUSES.has(run.status));
  const selectedRuns = useMemo(
    () => runs.filter((run) => run.task_id === selectedTask?.id).slice(0, 5),
    [runs, selectedTask?.id],
  );
  const canvasWorld = useMemo(
    () => worldSize(positions, canvasView),
    [canvasView, positions],
  );

  function resetTaskForm() {
    setName("");
    setKind("extract");
    setMode("table");
    setConnectionId("");
    setDatabase("");
    setTable("");
    setSql("");
    setDelimiter(",");
    setHasHeader(true);
    setInputDatasetId("");
    setSpec(EMPTY_SPEC);
  }

  function rememberSaved(nextTasks: TaskDefinition[], nextPositions: Record<string, Point>) {
    savedRef.current = cloneCanvas(nextTasks, nextPositions);
    savedIdsRef.current = new Set(nextTasks.map((task) => task.id));
    setDirty(false);
  }

  function positionsFrom(nextTasks: TaskDefinition[], layout?: WorkspaceLayout) {
    const stored = nodesFromLayout(layout);
    const next: Record<string, Point> = {};
    nextTasks.forEach((task, index) => {
      next[task.id] = stored[task.id] ?? fallbackPoint(index);
    });
    return next;
  }

  useEffect(() => {
    let cancelled = false;
    setRunLog(null);
    setLoadingLogId(null);
    setBusy(false);
    setError("");
    setPollError("");
    logRequestRef.current += 1;
    setLoading(true);
    Promise.all([
      workspaceApi.list(),
      connectionApi.getConnections(),
      datasetApi.list(),
    ])
      .then(([workspaceResponse, connectionResponse, datasetResponse]) => {
        if (cancelled) return;
        setWorkspaces(workspaceResponse.workspaces);
        setConnections(connectionResponse.connections);
        setDatasets(datasetResponse.datasets);
        if (!workspaceId && workspaceResponse.workspaces[0]) {
          navigate(`/workspace/${workspaceResponse.workspaces[0].id}`, { replace: true });
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(`${messages.workspace.loadError}: ${String(reason)}`);
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
      setTasks([]);
      setRuns([]);
      setPositions({});
      rememberSaved([], {});
      pendingViewRef.current = null;
      return;
    }
    let cancelled = false;
    pendingViewRef.current = null;
    setLoading(true);
    setError("");
    Promise.all([
      workspaceApi.get(workspaceId),
      taskApi.list(workspaceId),
      taskApi.listRuns(workspaceId),
    ])
      .then(([workspace, taskResponse, runResponse]) => {
        if (cancelled) return;
        setWorkspaces((current) => {
          const exists = current.some((item) => item.id === workspace.id);
          return exists
            ? current.map((item) => (item.id === workspace.id ? workspace : item))
            : [...current, workspace];
        });
        const nextPositions = positionsFrom(taskResponse.tasks, workspace.layout);
        pendingViewRef.current = workspace.layout.view ?? { x: 0, y: 0 };
        setTasks(taskResponse.tasks);
        setRuns(runResponse.runs);
        setPositions(nextPositions);
        rememberSaved(taskResponse.tasks, nextPositions);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(`${messages.workspace.loadError}: ${String(reason)}`);
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
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    return () => observer.disconnect();
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
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await taskApi.listRuns(workspaceId);
        if (cancelled) return;
        const stillActive = response.runs.some((run) => ACTIVE_STATUSES.has(run.status));
        if (stillActive) {
          setRuns(response.runs);
          setPollError("");
          timer = window.setTimeout(() => void poll(), 2000);
        } else {
          const datasetResponse = await datasetApi.list();
          if (cancelled) return;
          setRuns(response.runs);
          setDatasets(datasetResponse.datasets);
          setPollError("");
        }
      } catch (reason) {
        if (!cancelled) {
          setPollError(`${messages.workspace.runLoadError}: ${String(reason)}`);
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

  useEffect(() => {
    if (!selectedTask) {
      if (!taskId) resetTaskForm();
      return;
    }
    const config = selectedTask.config;
    setName(selectedTask.name);
    setKind(selectedTask.kind);
    const source = objectValue(config, "source");
    setMode(textValue(source, "type", "table"));
    setConnectionId(textValue(config, "connection_id"));
    setDatabase(textValue(source, "database"));
    setTable(textValue(source, "table"));
    setSql(textValue(source, "sql"));
    setDelimiter(textValue(config, "delimiter", ","));
    setHasHeader(boolValue(config, "header", true));
    setInputDatasetId(textValue(config, "input_dataset_id"));
    const savedSpec = config.spec;
    setSpec(savedSpec && typeof savedSpec === "object"
      ? JSON.stringify(savedSpec, null, 2)
      : EMPTY_SPEC);
  }, [selectedTask, taskId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
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
  }, [workspaceId]);

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const requestWorkspaceId = workspaceId;
    setBusy(true);
    setError("");
    try {
      const created = await workspaceApi.create({ name: workspaceName.trim() });
      if (currentWorkspaceRef.current !== requestWorkspaceId) return;
      setWorkspaces((current) => [...current, created]);
      setWorkspaceName("");
      setCreatingWorkspace(false);
      navigate(`/workspace/${created.id}`);
    } catch (reason) {
      if (currentWorkspaceRef.current === requestWorkspaceId) {
        setError(`${messages.workspace.createWorkspaceError}: ${String(reason)}`);
      }
    } finally {
      if (currentWorkspaceRef.current === requestWorkspaceId) setBusy(false);
    }
  }

  function taskConfig(): TaskConfig {
    if (kind === "extract") {
      return {
        connection_id: connectionId,
        source: mode === "table"
          ? { type: "table", table, ...(database.trim() ? { database } : {}) }
          : { type: "query", sql, ...(database.trim() ? { database } : {}) },
        delimiter,
        header: hasHeader,
      };
    }
    if (kind === "transform") {
      const parsed = JSON.parse(spec) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(messages.workspace.invalidSpec);
      }
      return { input_dataset_id: inputDatasetId, spec: parsed };
    }
    return {};
  }

  function applyTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceId || !selectedTask || kind === "load") return;
    try {
      const config = taskConfig();
      const nextName = name.trim();
      setTasks((current) =>
        current.map((task) =>
          task.id === selectedTask.id ? { ...task, name: nextName, config } : task,
        ),
      );
      setDirty(true);
      setError("");
    } catch (reason) {
      setError(`${messages.workspace.saveTaskError}: ${String(reason)}`);
    }
  }

  function placeTool(toolKind: "extract" | "transform", point: Point) {
    if (!workspaceId) return;
    const count = tasks.filter((task) => task.kind === toolKind).length + 1;
    const placedName = toolKind === "extract"
      ? messages.workspace.untitledExtract(count)
      : messages.workspace.untitledTransform(count);
    const created: TaskDefinition = {
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      name: placedName,
      kind: toolKind,
      config: draftConfig(toolKind),
      revision: 1,
      active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const viewport = {
      width: canvasRef.current?.clientWidth ?? 800,
      height: canvasRef.current?.clientHeight ?? 600,
    };
    const nextPoint = clampPoint(
      point,
      worldSize({ ...positionsRef.current, [created.id]: point }, viewport),
    );
    const next = { ...positionsRef.current, [created.id]: nextPoint };
    setTasks((current) => [created, ...current]);
    setPositions(next);
    setDirty(true);
    setError("");
    navigate(`/workspace/${workspaceId}/tasks/${created.id}`);
  }

  function dropTaskLocally(taskIdToDrop: string) {
    setTasks((current) => {
      const nextTasks = current.filter((item) => item.id !== taskIdToDrop);
      const nextPositions = omitPoint(positionsRef.current, taskIdToDrop);
      setPositions(nextPositions);
      savedRef.current = {
        tasks: savedRef.current.tasks.filter((item) => item.id !== taskIdToDrop),
        positions: omitPoint(savedRef.current.positions, taskIdToDrop),
      };
      savedIdsRef.current.delete(taskIdToDrop);
      const saved = savedRef.current;
      const dirtyNow = nextTasks.length !== saved.tasks.length
        || nextTasks.some((task) => {
          const original = saved.tasks.find((item) => item.id === task.id);
          return !original
            || original.name !== task.name
            || JSON.stringify(original.config) !== JSON.stringify(task.config);
        })
        || nextTasks.some((task) => {
          const currentPoint = nextPositions[task.id];
          const savedPoint = saved.positions[task.id];
          return !currentPoint || !savedPoint
            || currentPoint.x !== savedPoint.x
            || currentPoint.y !== savedPoint.y;
        });
      setDirty(dirtyNow);
      return nextTasks;
    });
    setRuns((current) => current.filter((run) => run.task_id !== taskIdToDrop));
    if (dragRef.current?.id === taskIdToDrop) dragRef.current = null;
  }

  async function deleteCanvasTask(task: TaskDefinition) {
    const confirmed = await showConfirm(
      messages.workspace.deleteTaskTitle,
      messages.workspace.deleteTaskMessage(task.name),
      { tone: "danger", confirmLabel: messages.common.delete },
    );
    if (!confirmed || currentWorkspaceRef.current !== workspaceId) return;
    setBusy(true);
    setError("");
    try {
      if (savedIdsRef.current.has(task.id)) {
        await taskApi.remove(task.id);
      }
      if (currentWorkspaceRef.current !== workspaceId) return;
      dropTaskLocally(task.id);
      if (taskId === task.id && workspaceId) {
        navigate(`/workspace/${workspaceId}`);
      }
    } catch (reason) {
      if (currentWorkspaceRef.current === workspaceId) {
        setError(`${messages.workspace.deleteTaskError}: ${String(reason)}`);
      }
    } finally {
      if (currentWorkspaceRef.current === workspaceId) setBusy(false);
    }
  }

  async function saveCanvas() {
    if (!workspaceId) return;
    const requestWorkspaceId = workspaceId;
    setBusy(true);
    setError("");
    try {
      let nextTasks = tasks;
      if (selectedTask && kind !== "load") {
        const config = taskConfig();
        nextTasks = tasks.map((task) =>
          task.id === selectedTask.id ? { ...task, name: name.trim(), config } : task,
        );
        setTasks(nextTasks);
      }
      const response = await workspaceApi.save(requestWorkspaceId, {
        layout: {
          nodes: Object.fromEntries(
            Object.entries(positionsRef.current).map(([id, point]) => [id, roundPoint(point)]),
          ),
          view: {
            x: Math.round(canvasRef.current?.scrollLeft ?? 0),
            y: Math.round(canvasRef.current?.scrollTop ?? 0),
          },
        },
        tasks: nextTasks.map((task) => ({
          id: task.id,
          name: task.name,
          kind: task.kind,
          config: task.config,
        })),
      });
      if (currentWorkspaceRef.current !== requestWorkspaceId) return;
      const nextPositions = positionsFrom(response.tasks, response.workspace.layout);
      setWorkspaces((current) =>
        current.map((item) =>
          item.id === response.workspace.id ? response.workspace : item,
        ),
      );
      setTasks(response.tasks);
      setPositions(nextPositions);
      rememberSaved(response.tasks, nextPositions);
    } catch (reason) {
      if (currentWorkspaceRef.current === requestWorkspaceId) {
        setError(`${messages.workspace.saveTaskError}: ${String(reason)}`);
      }
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

  function resetCanvas() {
    const saved = cloneCanvas(savedRef.current.tasks, savedRef.current.positions);
    setTasks(saved.tasks);
    setPositions(saved.positions);
    setDirty(false);
    setError("");
    if (taskId && !savedIdsRef.current.has(taskId) && workspaceId) {
      navigate(`/workspace/${workspaceId}`);
    }
  }

  async function refreshWorkspace() {
    const requestWorkspaceId = workspaceId;
    const requestId = ++refreshRequestRef.current;
    setRefreshing(true);
    setError("");
    setPollError("");
    try {
      const [workspaceResponse, connectionResponse, datasetResponse] = await Promise.all([
        workspaceApi.list(),
        connectionApi.getConnections(),
        datasetApi.list(),
      ]);
      if (refreshRequestRef.current !== requestId) return;
      setWorkspaces(workspaceResponse.workspaces);
      setConnections(connectionResponse.connections);
      setDatasets(datasetResponse.datasets);
      if (!requestWorkspaceId) return;
      const [workspace, taskResponse, runResponse] = await Promise.all([
        workspaceApi.get(requestWorkspaceId),
        taskApi.list(requestWorkspaceId),
        taskApi.listRuns(requestWorkspaceId),
      ]);
      if (refreshRequestRef.current !== requestId) return;
      setWorkspaces((current) => {
        const exists = current.some((item) => item.id === workspace.id);
        return exists
          ? current.map((item) => (item.id === workspace.id ? workspace : item))
          : [...current, workspace];
      });
      setRuns(runResponse.runs);
      if (dirtyRef.current) return;
      const nextPositions = positionsFrom(taskResponse.tasks, workspace.layout);
      pendingViewRef.current = workspace.layout.view ?? { x: 0, y: 0 };
      setTasks(taskResponse.tasks);
      setPositions(nextPositions);
      rememberSaved(taskResponse.tasks, nextPositions);
    } catch (reason) {
      if (refreshRequestRef.current === requestId) {
        setError(`${messages.workspace.loadError}: ${String(reason)}`);
      }
    } finally {
      if (refreshRequestRef.current === requestId) setRefreshing(false);
    }
  }

  requestSaveRef.current = () => {
    void requestSave();
  };
  resetCanvasRef.current = resetCanvas;

  async function runTask() {
    if (!selectedTask || selectedTask.kind === "load") return;
    const requestWorkspaceId = selectedTask.workspace_id;
    setBusy(true);
    setError("");
    try {
      const request = selectedTask.kind === "transform" && inputDatasetId
        ? { input_dataset_id: inputDatasetId }
        : {};
      await taskApi.run(selectedTask.id, request);
      if (currentWorkspaceRef.current !== requestWorkspaceId) return;
      const response = await taskApi.listRuns(selectedTask.workspace_id);
      if (currentWorkspaceRef.current !== requestWorkspaceId) return;
      setRuns(response.runs);
    } catch (reason) {
      if (currentWorkspaceRef.current === requestWorkspaceId) {
        setError(`${messages.workspace.runTaskError}: ${String(reason)}`);
      }
    } finally {
      if (currentWorkspaceRef.current === requestWorkspaceId) setBusy(false);
    }
  }

  async function showRunLog(runId: string) {
    const requestWorkspaceId = workspaceId;
    const requestId = ++logRequestRef.current;
    setLoadingLogId(runId);
    setRunLog(null);
    setError("");
    try {
      const response = await taskApi.getRunLogs(runId);
      if (
        currentWorkspaceRef.current === requestWorkspaceId &&
        logRequestRef.current === requestId
      ) {
        setRunLog(response);
      }
    } catch (reason) {
      if (
        currentWorkspaceRef.current === requestWorkspaceId &&
        logRequestRef.current === requestId
      ) {
        setError(`${messages.workspace.runLogError}: ${String(reason)}`);
      }
    } finally {
      if (
        currentWorkspaceRef.current === requestWorkspaceId &&
        logRequestRef.current === requestId
      ) {
        setLoadingLogId(null);
      }
    }
  }

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
    const toolKind = event.dataTransfer.getData(TOOL_KIND);
    if (toolKind !== "extract" && toolKind !== "transform") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const grab = canvasPoint(canvas, event.clientX, event.clientY);
    placeTool(toolKind, {
      x: grab.x - NODE_W / 2,
      y: grab.y - NODE_H / 2,
    });
  }

  function onNodePointerDown(task: TaskDefinition, event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const node = positionsRef.current[task.id] ?? { x: 56, y: 48 };
    const grab = canvasPoint(canvas, event.clientX, event.clientY);
    dragRef.current = {
      id: task.id,
      dx: grab.x - node.x,
      dy: grab.y - node.y,
      startX: node.x,
      startY: node.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onNodePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const canvas = canvasRef.current;
    if (!drag || !canvas || drag.id !== event.currentTarget.dataset.taskId) return;
    scrollCanvasFromPointer(canvas, event.clientX, event.clientY);
    const grab = canvasPoint(canvas, event.clientX, event.clientY);
    const tentative = { x: grab.x - drag.dx, y: grab.y - drag.dy };
    const nextPoint = clampPoint(
      tentative,
      worldSize({ ...positionsRef.current, [drag.id]: tentative }, {
        width: canvas.clientWidth,
        height: canvas.clientHeight,
      }),
    );
    if (Math.abs(nextPoint.x - drag.startX) > 3
      || Math.abs(nextPoint.y - drag.startY) > 3) {
      drag.moved = true;
    }
    setPositions((current) => ({ ...current, [drag.id]: nextPoint }));
  }

  function onNodePointerUp(task: TaskDefinition) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.id !== task.id) return;
    if (drag.moved) {
      setDirty(true);
      return;
    }
    navigate(`/workspace/${workspaceId}/tasks/${task.id}`);
  }

  const validExtract = connectionId && (mode === "table" ? table.trim() : sql.trim());
  const validTransform = inputDatasetId && spec.trim();
  const canSave = Boolean(selectedTask) && name.trim() && kind !== "load" &&
    (kind === "extract" ? validExtract : validTransform);
  const latestByTask = useMemo(() => {
    const map = new Map<string, TaskRun>();
    for (const run of runs) {
      if (!map.has(run.task_id)) map.set(run.task_id, run);
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

  return (
    <SplitLayout
      reverse
      className="h-full min-h-0 bg-canvas"
      defaultSizes={[layout.split.sidebar + 28]}
    >
      <aside className="flex h-full min-h-0 flex-col overflow-hidden bg-surface">
        <div className="border-b border-border p-3">
          <label className="flex flex-col gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
            {messages.workspace.workspace}
            <Select
              value={workspaceId ?? ""}
              placeholder={loading ? messages.common.loading : messages.workspace.selectWorkspace}
              options={workspaces.map((workspace) => ({
                value: workspace.id,
                label: workspace.name,
              }))}
              onChange={(id) => navigate(id ? `/workspace/${id}` : "/workspace")}
            />
          </label>
          <Button
            className="mt-2 w-full"
            type="button"
            onClick={() => setCreatingWorkspace((value) => !value)}
          >
            {messages.workspace.newWorkspace}
          </Button>
          {creatingWorkspace ? (
            <form className="mt-2 flex flex-col gap-2" onSubmit={(event) => void createWorkspace(event)}>
              <input
                className="field-control"
                value={workspaceName}
                required
                placeholder={messages.workspace.name}
                onChange={(event) => setWorkspaceName(event.target.value)}
              />
              <Button type="submit" variant="primary" disabled={busy || !workspaceName.trim()}>
                {messages.workspace.create}
              </Button>
            </form>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {error || pollError ? (
            <div role="alert" className="mb-3 rounded-lg border border-danger/30 bg-danger-subtle px-3 py-2 text-xs text-danger">
              {error || pollError}
            </div>
          ) : null}

          {selectedTask ? (
            <form className="flex flex-col gap-3" onSubmit={applyTask}>
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-text">{messages.workspace.inspector}</h2>
                <Button
                  type="button"
                  variant="quiet"
                  onClick={() => navigate(`/workspace/${workspaceId}`)}
                >
                  {messages.workspace.closeInspector}
                </Button>
              </div>
              <label className="flex flex-col gap-1.5 text-xs font-medium text-text-secondary">
                {messages.workspace.taskName}
                <input className="field-control" value={name} required onChange={(event) => setName(event.target.value)} />
              </label>

              {kind === "extract" ? (
                <>
                  <label className="flex flex-col gap-1.5 text-xs font-medium text-text-secondary">
                    {messages.workspace.mode}
                    <Select
                      value={mode}
                      options={[
                        { value: "table", label: messages.workspace.tableMode },
                        { value: "query", label: messages.workspace.queryMode },
                      ]}
                      onChange={setMode}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-xs font-medium text-text-secondary">
                    {messages.workspace.connection}
                    <Select
                      value={connectionId}
                      placeholder={messages.workspace.selectConnection}
                      options={connections.map((connection) => ({ value: connection.id, label: connection.name }))}
                      onChange={setConnectionId}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-xs font-medium text-text-secondary">
                    {messages.workspace.database}
                    <input
                      className="field-control technical"
                      value={database}
                      placeholder={messages.workspace.databaseOptional}
                      onChange={(event) => setDatabase(event.target.value)}
                    />
                  </label>
                  {mode === "table" ? (
                    <label className="flex flex-col gap-1.5 text-xs font-medium text-text-secondary">
                      {messages.workspace.table}
                      <input className="field-control technical" value={table} required onChange={(event) => setTable(event.target.value)} />
                    </label>
                  ) : (
                    <label className="flex flex-col gap-1.5 text-xs font-medium text-text-secondary">
                      {messages.workspace.sql}
                      <textarea className="field-control technical min-h-24 resize-y" value={sql} required onChange={(event) => setSql(event.target.value)} />
                    </label>
                  )}
                  <label className="flex flex-col gap-1.5 text-xs font-medium text-text-secondary">
                    {messages.common.delimiter}
                    <input className="field-control technical" value={delimiter} required onChange={(event) => setDelimiter(event.target.value)} />
                  </label>
                  <label className="flex items-center gap-2 text-xs font-medium text-text-secondary">
                    <input type="checkbox" checked={hasHeader} onChange={(event) => setHasHeader(event.target.checked)} />
                    {messages.workspace.hasHeader}
                  </label>
                </>
              ) : kind === "transform" ? (
                <>
                  <label className="flex flex-col gap-1.5 text-xs font-medium text-text-secondary">
                    {messages.workspace.inputDataset}
                    <Select
                      value={inputDatasetId}
                      placeholder={messages.workspace.selectDataset}
                      options={datasets
                        .filter((dataset) => dataset.available && dataset.workspace_id === workspaceId)
                        .map((dataset) => ({ value: dataset.id, label: dataset.filename }))}
                      onChange={setInputDatasetId}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-xs font-medium text-text-secondary">
                    {messages.workspace.transformSpec}
                    <textarea
                      className="field-control technical min-h-36 resize-y"
                      value={spec}
                      required
                      spellCheck={false}
                      onChange={(event) => setSpec(event.target.value)}
                    />
                  </label>
                </>
              ) : (
                <p className="text-sm text-warning">{messages.workspace.loadUnavailable}</p>
              )}

              <div className="flex gap-2">
                <Button type="submit" variant="primary" disabled={busy || !canSave}>
                  {messages.workspace.applyTask}
                </Button>
                <Button
                  type="button"
                  disabled={busy || !selectedTask.active || !canSave || dirty || !savedIdsRef.current.has(selectedTask.id)}
                  title={dirty || !savedIdsRef.current.has(selectedTask.id) ? messages.workspace.saveFirst : undefined}
                  onClick={() => void runTask()}
                >
                  {messages.common.run}
                </Button>
              </div>

              {selectedRuns.length > 0 ? (
                <div className="border-t border-border pt-3">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                    {messages.workspace.recentRuns}
                  </p>
                  <ul className="space-y-2">
                    {selectedRuns.map((run) => (
                      <li key={run.id} className="rounded-lg border border-border bg-raised px-2 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <StatusPill value={run.status} />
                          <span className="technical text-[11px] text-text-tertiary">{fmtWhen(run.created_at)}</span>
                        </div>
                        {run.error_message ? (
                          <p className="mt-1 truncate text-[11px] text-danger" title={run.error_message}>{run.error_message}</p>
                        ) : null}
                        <Button
                          className="mt-1"
                          type="button"
                          variant="quiet"
                          disabled={loadingLogId === run.id}
                          onClick={() => void showRunLog(run.id)}
                        >
                          {messages.workspace.logs}
                        </Button>
                      </li>
                    ))}
                  </ul>
                  {runLog ? (
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-subtle p-2 text-[11px] text-text-secondary">
                      {runLog.text || messages.workspace.noRunLog}
                    </pre>
                  ) : null}
                </div>
              ) : null}
            </form>
          ) : (
            <p className="text-sm text-text-secondary">
              {workspaceId ? messages.workspace.canvasHint : messages.workspace.noWorkspaces}
            </p>
          )}
        </div>

        {workspaceId ? (
          <div className="grid shrink-0 grid-cols-2 items-center gap-2 border-t border-border bg-surface p-3">
            <span className="col-start-2 justify-self-end rounded-full border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold tabular-nums text-text-secondary shadow-sm">
              {messages.workspace.version(selectedWorkspace?.version ?? 1)}
              {dirty ? ` · ${messages.workspace.unsaved}` : ""}
            </span>
            <Button
              type="button"
              className="w-full gap-2"
              disabled={busy || !dirty}
              onClick={resetCanvas}
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {messages.workspace.resetCanvas}
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
                  selectedTask
                    ? selectedTask.kind === "extract"
                      ? "text-accent"
                      : "text-success"
                    : "text-text",
                )}
              >
                {selectedTask ? (
                  selectedTask.kind === "transform" ? (
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
                  {selectedTask
                    ? selectedWorkspace?.name ?? messages.workspace.title
                    : messages.workspace.title}
                </p>
                <h1 className="mt-0.5 min-w-0 truncate text-sm font-semibold tracking-[-0.015em] text-text">
                  {selectedTask
                    ? name.trim() || selectedTask.name
                    : selectedWorkspace?.name ?? messages.workspace.selectWorkspace}
                </h1>
              </div>
            </div>
            <ul className="flex shrink-0 items-center gap-3">
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
        {tasks.length === 0 && workspaceId ? (
          <p className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-sm text-text-tertiary">
            {loading ? messages.common.loading : messages.workspace.canvasHint}
          </p>
        ) : null}
        <section
          ref={canvasRef}
          role="application"
          aria-label={messages.workspace.canvasAria}
          className="workspace-canvas relative h-full min-h-0 min-w-0 overflow-auto overscroll-contain"
          onDragOver={(event) => event.preventDefault()}
          onDrop={onCanvasDrop}
        >
          <div
            className="relative"
            style={{
              width: canvasWorld.width,
              height: canvasWorld.height,
              backgroundImage: "radial-gradient(circle, var(--theme-canvas-dot) 1px, transparent 1.5px)",
              backgroundSize: "22px 22px",
            }}
            onClick={(event) => {
              if (event.target === event.currentTarget && workspaceId) {
                navigate(`/workspace/${workspaceId}`);
              }
            }}
          >
        {tasks.map((task) => {
          const point = positions[task.id] ?? fallbackPoint(0);
          const latest = latestByTask.get(task.id);
          const configured = task.kind === "extract"
            ? Boolean(textValue(task.config, "connection_id"))
            : Boolean(textValue(task.config, "input_dataset_id"));
          const Icon = task.kind === "transform" ? Workflow : DatabaseZap;
          return (
            <div
              key={task.id}
              role="button"
              tabIndex={0}
              data-task-id={task.id}
              aria-current={task.id === taskId ? "true" : undefined}
              aria-label={task.name}
              className={cn(
                "workspace-node absolute flex w-[128px] cursor-grab select-none flex-col items-center gap-1 px-2 pb-2.5 pt-5 text-center active:cursor-grabbing",
                task.id === taskId && "is-selected",
              )}
              style={{ left: point.x, top: point.y }}
              onPointerDown={(event) => onNodePointerDown(task, event)}
              onPointerMove={onNodePointerMove}
              onPointerUp={() => onNodePointerUp(task)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  navigate(`/workspace/${workspaceId}/tasks/${task.id}`);
                }
              }}
            >
              <button
                type="button"
                className="absolute right-1 top-1 z-10 grid size-5 place-items-center rounded-md text-text-tertiary outline-none hover:bg-danger-subtle hover:text-danger focus-visible:ring-2 focus-visible:ring-accent/40"
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
                  void deleteCanvasTask(task);
                }}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
              <span className={cn(
                "workspace-node-icon",
                task.kind === "extract" ? "is-extract" : "is-transform",
              )}>
                <Icon aria-hidden="true" />
              </span>
              <span className="w-full truncate text-xs font-semibold text-text">{task.name}</span>
              <span className="text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
                {task.kind === "extract" ? messages.workspace.extract : messages.workspace.transform}
              </span>
              {latest ? <StatusPill value={latest.status} /> : !configured ? (
                <span className="text-[10px] text-text-tertiary">
                  {messages.workspace.notConfigured}
                </span>
              ) : null}
            </div>
          );
        })}
          </div>
        </section>
        </div>
      </div>
    </SplitLayout>
  );
}
