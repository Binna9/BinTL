import { DragEvent, FormEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { DatabaseZap, RotateCcw, Save, Upload, Workflow } from "lucide-react";
import { StatusPill } from "@/components/StatusPill";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { fmtWhen } from "@/lib/format";
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
const NODE_W = 156;
const NODE_H = 128;

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
  return { x: 56 + (index % 4) * 188, y: 48 + Math.floor(index / 4) * 156 };
}

function clampPoint(point: Point, bounds: { width: number; height: number }): Point {
  return {
    x: Math.max(16, Math.min(point.x, Math.max(16, bounds.width - NODE_W - 16))),
    y: Math.max(16, Math.min(point.y, Math.max(16, bounds.height - NODE_H - 16))),
  };
}

export function WorkspacePage() {
  const { messages } = useLanguage();
  const navigate = useNavigate();
  const { workspaceId, taskId } = useParams<{ workspaceId: string; taskId: string }>();
  const currentWorkspaceRef = useRef(workspaceId);
  const logRequestRef = useRef(0);
  const canvasRef = useRef<HTMLDivElement>(null);
  const positionsRef = useRef<Record<string, Point>>({});
  const savedRef = useRef<CanvasSnapshot>({ tasks: [], positions: {} });
  const savedIdsRef = useRef(new Set<string>());
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

  const selectedWorkspace = workspaces.find((item) => item.id === workspaceId);
  const selectedTask = tasks.find(
    (item) => item.id === taskId && item.workspace_id === workspaceId,
  );
  const hasActiveRun = runs.some((run) => ACTIVE_STATUSES.has(run.status));
  const selectedRuns = useMemo(
    () => runs.filter((run) => run.task_id === selectedTask?.id).slice(0, 5),
    [runs, selectedTask?.id],
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
      return;
    }
    let cancelled = false;
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
    const bounds = canvasRef.current?.getBoundingClientRect();
    const nextPoint = clampPoint(point, {
      width: bounds?.width ?? 800,
      height: bounds?.height ?? 600,
    });
    const next = { ...positionsRef.current, [created.id]: nextPoint };
    setTasks((current) => [created, ...current]);
    setPositions(next);
    setDirty(true);
    setError("");
    navigate(`/workspace/${workspaceId}/tasks/${created.id}`);
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
        layout: { nodes: positionsRef.current },
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
  }

  function onCanvasDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const toolKind = event.dataTransfer.getData(TOOL_KIND);
    if (toolKind !== "extract" && toolKind !== "transform") return;
    const rect = event.currentTarget.getBoundingClientRect();
    placeTool(toolKind, {
      x: event.clientX - rect.left - NODE_W / 2,
      y: event.clientY - rect.top - NODE_H / 2,
    });
  }

  function onNodePointerDown(task: TaskDefinition, event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    const node = positionsRef.current[task.id] ?? { x: 56, y: 48 };
    dragRef.current = {
      id: task.id,
      dx: event.clientX - node.x,
      dy: event.clientY - node.y,
      startX: node.x,
      startY: node.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onNodePointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.currentTarget.dataset.taskId) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    const nextPoint = clampPoint(
      { x: event.clientX - drag.dx, y: event.clientY - drag.dy },
      { width: rect?.width ?? 800, height: rect?.height ?? 600 },
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
      enabled: true,
    },
    {
      kind: "transform" as const,
      label: messages.workspace.transform,
      hint: messages.workspace.transformHint,
      icon: Workflow,
      enabled: true,
    },
    {
      kind: "load" as const,
      label: messages.workspace.load,
      hint: messages.workspace.loadHint,
      icon: Upload,
      enabled: false,
    },
  ];

  return (
    <div className="flex h-full min-h-0 bg-canvas">
      <aside className="flex w-[18.5rem] shrink-0 flex-col border-r border-border bg-surface">
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

        <div className="border-b border-border p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
            {messages.workspace.tools}
          </p>
          <div className="grid grid-cols-3 gap-2">
            {tools.map((tool) => {
              const Icon = tool.icon;
              return (
                <button
                  key={tool.kind}
                  type="button"
                  draggable={tool.enabled}
                  disabled={!tool.enabled || busy || !workspaceId}
                  title={tool.hint}
                  aria-label={`${tool.label}. ${tool.hint}`}
                  className={cn(
                    "flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-center transition-colors",
                    tool.enabled
                      ? "border-border bg-raised text-text hover:border-accent hover:bg-accent-subtle"
                      : "cursor-not-allowed border-border bg-subtle text-text-tertiary",
                  )}
                  onDragStart={(event) => {
                    if (tool.kind === "load") return;
                    onToolDragStart(tool.kind, event);
                  }}
                  onClick={() => {
                    if (!tool.enabled || tool.kind === "load") return;
                    placeTool(tool.kind, fallbackPoint(tasks.length));
                  }}
                >
                  <span className={cn(
                    "flex size-10 items-center justify-center rounded-lg",
                    tool.kind === "extract" && "bg-accent-subtle text-accent",
                    tool.kind === "transform" && "bg-success-subtle text-success",
                    tool.kind === "load" && "bg-warning-subtle text-warning",
                  )}>
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  <span className="text-[11px] font-semibold">{tool.label}</span>
                </button>
              );
            })}
          </div>
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
      </aside>

      <section
        ref={canvasRef}
        role="application"
        aria-label={messages.workspace.canvasAria}
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
        style={{
          backgroundImage: "radial-gradient(circle, var(--theme-canvas-dot) 1px, transparent 1.5px)",
          backgroundSize: "22px 22px",
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={onCanvasDrop}
        onClick={(event) => {
          if (event.target === event.currentTarget && workspaceId) {
            navigate(`/workspace/${workspaceId}`);
          }
        }}
      >
        {tasks.length === 0 && workspaceId ? (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-text-tertiary">
            {loading ? messages.common.loading : messages.workspace.canvasHint}
          </p>
        ) : null}

        {tasks.map((task) => {
          const point = positions[task.id] ?? fallbackPoint(0);
          const latest = latestByTask.get(task.id);
          const configured = task.kind === "extract"
            ? Boolean(textValue(task.config, "connection_id"))
            : Boolean(textValue(task.config, "input_dataset_id"));
          const Icon = task.kind === "transform" ? Workflow : DatabaseZap;
          return (
            <button
              key={task.id}
              type="button"
              data-task-id={task.id}
              aria-current={task.id === taskId ? "true" : undefined}
              className={cn(
                "absolute flex w-[156px] cursor-grab flex-col items-center gap-2 rounded-2xl border bg-surface px-3 py-4 text-center shadow-[0_10px_24px_rgba(15,23,42,0.08)] active:cursor-grabbing",
                task.id === taskId ? "border-accent ring-2 ring-accent/30" : "border-border hover:border-accent",
              )}
              style={{ left: point.x, top: point.y }}
              onPointerDown={(event) => onNodePointerDown(task, event)}
              onPointerMove={onNodePointerMove}
              onPointerUp={() => onNodePointerUp(task)}
            >
              <span className={cn(
                "flex size-12 items-center justify-center rounded-2xl",
                task.kind === "extract" ? "bg-accent-subtle text-accent" : "bg-success-subtle text-success",
              )}>
                <Icon className="size-6" aria-hidden="true" />
              </span>
              <span className="w-full truncate text-sm font-semibold text-text">{task.name}</span>
              <span className="text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
                {task.kind === "extract" ? messages.workspace.extract : messages.workspace.transform}
              </span>
              {latest ? <StatusPill value={latest.status} /> : !configured ? (
                <span className="text-[11px] text-text-tertiary">
                  {messages.workspace.notConfigured}
                </span>
              ) : null}
            </button>
          );
        })}
        {workspaceId ? (
          <div className="absolute bottom-4 right-4 z-10 flex items-center gap-2">
            <span className="rounded-full border border-border bg-surface/95 px-2.5 py-1 text-[11px] font-semibold tabular-nums text-text-secondary shadow-sm">
              {messages.workspace.version(selectedWorkspace?.version ?? 1)}
              {dirty ? ` · ${messages.workspace.unsaved}` : ""}
            </span>
            <Button
              type="button"
              className="gap-2"
              disabled={busy || !dirty}
              onClick={resetCanvas}
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {messages.workspace.resetCanvas}
            </Button>
            <Button
              type="button"
              variant="primary"
              className="gap-2"
              disabled={busy || !dirty}
              onClick={() => void saveCanvas()}
            >
              <Save className="size-3.5" aria-hidden="true" />
              {busy ? messages.common.saving : messages.workspace.saveCanvas}
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
