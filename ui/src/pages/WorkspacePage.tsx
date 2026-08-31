import { DragEvent, FormEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { AppWindow, ArrowRight, Check, ChevronDown, CircleAlert, DatabaseZap, Folder, FolderOpen, Layers, Plus, RefreshCw, RotateCcw, Save, Search, Settings2, Spline, Workflow, X, type LucideIcon } from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { SplitLayout } from "@/components/SplitLayout";
import { StatusPill } from "@/components/StatusPill";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { WorkspaceManageDialog } from "@/components/WorkspaceManageDialog";
import { useLanguage } from "@/i18n/LanguageProvider";
import type { Messages } from "@/i18n/ko";
import { cn } from "@/lib/cn";
import { fmtWhen } from "@/lib/format";
import { layout } from "@/lib/layout";
import { showConfirm } from "@/lib/notifications";
import { connectionApi } from "@/services/connectionApi";
import { datasetApi } from "@/services/datasetApi";
import { chipApi } from "@/services/chipApi";
import { workspaceApi } from "@/services/workspaceApi";
import type { DataConnection } from "@/types/connection";
import type { Dataset } from "@/types/dataset";
import type { Chip, ChipConfig, ChipEdge, ChipEdgeKind, ChipKind, ChipRun, RunChipRequest } from "@/types/chip";
import type { Workspace, WorkspaceFolder, WorkspaceLayout } from "@/types/workspace";

const EMPTY_SPEC = JSON.stringify(
  { version: 2, sink: "parquet", steps: [] },
  null,
  2,
);
const ACTIVE_STATUSES = new Set(["queued", "running"]);
const TOOL_KIND = "application/x-bintl-tool";
const NODE_W = 100;
const NODE_H = 96;
const CHIP_PLACE_GAP = 28;
const CANVAS_W = 3200;
const CANVAS_H = 2200;
const CANVAS_EDGE = 56;
const CANVAS_SCROLL_STEP = 18;
const MINIMAP_W = 168;
const MINIMAP_H = 116;

type Point = { x: number; y: number };
type CanvasSnapshot = { chips: Chip[]; positions: Record<string, Point>; edges: ChipEdge[] };

function cloneCanvas(
  chips: Chip[],
  positions: Record<string, Point>,
  edges: ChipEdge[],
): CanvasSnapshot {
  return JSON.parse(JSON.stringify({ chips, positions, edges })) as CanvasSnapshot;
}

function textValue(config: ChipConfig, key: string, fallback = ""): string {
  return typeof config[key] === "string" ? config[key] as string : fallback;
}

function boolValue(config: ChipConfig, key: string, fallback: boolean): boolean {
  return typeof config[key] === "boolean" ? config[key] as boolean : fallback;
}

function objectValue(config: ChipConfig, key: string): ChipConfig {
  const value = config[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ChipConfig
    : {};
}

function nodesFromLayout(layout?: WorkspaceLayout): Record<string, Point> {
  return layout?.nodes ?? {};
}

function fallbackPoint(index: number): Point {
  return { x: 96 + (index % 5) * 128, y: 48 + Math.floor(index / 5) * 112 };
}

function clampPoint(point: Point, bounds: { width: number; height: number } = { width: CANVAS_W, height: CANVAS_H }): Point {
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

function pointerOutsideCanvas(canvas: HTMLElement, clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect();
  return clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom;
}

function releasePointer(target: Element, pointerId: number) {
  if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
}

type MarqueeBox = { x0: number; y0: number; x1: number; y1: number };

function normalizeMarquee(box: MarqueeBox) {
  return {
    x: Math.min(box.x0, box.x1),
    y: Math.min(box.y0, box.y1),
    w: Math.abs(box.x1 - box.x0),
    h: Math.abs(box.y1 - box.y0),
  };
}

function chipInMarquee(point: Point, box: MarqueeBox): boolean {
  const area = normalizeMarquee(box);
  return (
    point.x < area.x + area.w &&
    point.x + NODE_W > area.x &&
    point.y < area.y + area.h &&
    point.y + NODE_H > area.y
  );
}

function roundPoint(point: Point): Point {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

function normalizeChipName(name: string) {
  return name.trim().toLowerCase();
}

function folderPathLabel(
  folderId: string | null | undefined,
  folders: WorkspaceFolder[],
  rootSegment: string,
): string {
  const segments = [rootSegment];
  let cursor: string | null = folderId ?? null;
  while (cursor) {
    const folder = folders.find((item) => item.id === cursor);
    if (!folder) break;
    segments.push(folder.name);
    cursor = folder.parent_id;
  }
  return segments.join("/");
}

function WorkspaceInfoRow({
  icon: Icon,
  label,
  value,
  valueClassName,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-xl px-2.5 py-2" title={`${label} ${value}`}>
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-subtle">
        <Icon className="size-3.5 text-text-secondary" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">{label}</p>
        <p className={cn("truncate text-[13px] font-medium text-text", valueClassName)}>{value}</p>
      </div>
    </div>
  );
}

function WorkspaceBrowserPanel({
  messages,
  folderPath,
  workspaceName,
  onManage,
}: {
  messages: Messages;
  folderPath: string;
  workspaceName: string;
  onManage: () => void;
}) {
  return (
    <section className="workspace-rail-group">
      <div className="flex items-center gap-2 px-1 py-1.5">
        <FolderOpen className="size-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
        <span className="text-sm font-semibold text-text">{messages.workspace.browser}</span>
      </div>
      <div className="flex flex-col gap-0.5 pt-1">
        <WorkspaceInfoRow
          icon={Folder}
          label={messages.workspace.folderTree}
          value={folderPath}
          valueClassName="technical"
        />
        <WorkspaceInfoRow
          icon={AppWindow}
          label={messages.workspace.workspace}
          value={workspaceName}
        />
      </div>
      <Button className="mt-2.5 w-full" type="button" onClick={onManage}>
        <Settings2 className="size-3.5" aria-hidden="true" />
        {messages.workspace.manageTitle}
      </Button>
    </section>
  );
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

type PortSide = "left" | "right" | "top" | "bottom";

type EdgeGeometry = {
  d: string;
  start: Point;
  end: Point;
  c1: Point;
  c2: Point;
  fromSide: PortSide;
  toSide: PortSide;
};

function chipCenter(point: Point): Point {
  return { x: point.x + NODE_W / 2, y: point.y + NODE_H / 2 };
}

function portPoint(chip: Point, side: PortSide): Point {
  if (side === "top") return { x: chip.x + NODE_W / 2, y: chip.y };
  if (side === "bottom") return { x: chip.x + NODE_W / 2, y: chip.y + NODE_H };
  return {
    x: side === "right" ? chip.x + NODE_W : chip.x,
    y: chip.y + NODE_H / 2,
  };
}

function oppositeSide(side: PortSide): PortSide {
  if (side === "left") return "right";
  if (side === "right") return "left";
  if (side === "top") return "bottom";
  return "top";
}

function asPortSide(value: string, fallback: PortSide = "right"): PortSide {
  if (value === "left" || value === "right" || value === "top" || value === "bottom") return value;
  return fallback;
}

function routeSides(from: Point, to: Point): { fromSide: PortSide; toSide: PortSide } {
  const a = chipCenter(from);
  const b = chipCenter(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dy) > Math.abs(dx)) {
    return dy < 0
      ? { fromSide: "top", toSide: "bottom" }
      : { fromSide: "bottom", toSide: "top" };
  }
  return dx < 0
    ? { fromSide: "left", toSide: "right" }
    : { fromSide: "right", toSide: "left" };
}

function exitControl(point: Point, side: PortSide, dist: number): Point {
  if (side === "top") return { x: point.x, y: point.y - dist };
  if (side === "bottom") return { x: point.x, y: point.y + dist };
  return {
    x: side === "right" ? point.x + dist : point.x - dist,
    y: point.y,
  };
}

function cubicPath(start: Point, c1: Point, c2: Point, end: Point): string {
  return `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
}

function controlDistance(start: Point, end: Point) {
  return Math.max(64, Math.hypot(end.x - start.x, end.y - start.y) * 0.42);
}

function edgeGeometry(from: Point, to: Point): EdgeGeometry {
  const { fromSide, toSide } = routeSides(from, to);
  const start = portPoint(from, fromSide);
  const end = portPoint(to, toSide);
  const dist = controlDistance(start, end);
  const c1 = exitControl(start, fromSide, dist);
  const c2 = exitControl(end, toSide, dist);
  return { d: cubicPath(start, c1, c2, end), start, end, c1, c2, fromSide, toSide };
}

function previewGeometry(from: Point, cursor: Point, fromSide: PortSide): EdgeGeometry {
  const center = chipCenter(from);
  const dx = cursor.x - center.x;
  const dy = cursor.y - center.y;
  const side: PortSide = Math.abs(dx) < 8 && Math.abs(dy) < 8
    ? fromSide
    : Math.abs(dy) > Math.abs(dx)
      ? (dy < 0 ? "top" : "bottom")
      : (dx < 0 ? "left" : "right");
  const toSide = oppositeSide(side);
  const start = portPoint(from, side);
  const dist = controlDistance(start, cursor);
  const c1 = exitControl(start, side, dist);
  const c2 = exitControl(cursor, toSide, dist * 0.55);
  return {
    d: cubicPath(start, c1, c2, cursor),
    start,
    end: cursor,
    c1,
    c2,
    fromSide: side,
    toSide,
  };
}

function cubicAt(start: Point, c1: Point, c2: Point, end: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * start.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x,
    y: u * u * u * start.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y,
  };
}

function cubicTangent(start: Point, c1: Point, c2: Point, end: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: 3 * u * u * (c1.x - start.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (end.x - c2.x),
    y: 3 * u * u * (c1.y - start.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (end.y - c2.y),
  };
}

function flowMarks(geo: EdgeGeometry): Array<Point & { angle: number }> {
  return [0.34, 0.52, 0.7].map((t) => {
    const point = cubicAt(geo.start, geo.c1, geo.c2, geo.end, t);
    const tangent = cubicTangent(geo.start, geo.c1, geo.c2, geo.end, t);
    return {
      ...point,
      angle: (Math.atan2(tangent.y, tangent.x) * 180) / Math.PI,
    };
  });
}

function wireTone(kind: ChipEdgeKind): "is-data" | "is-then" | "is-error" {
  if (kind === "on_error") return "is-error";
  if (kind === "then") return "is-then";
  return "is-data";
}

function defaultEdgeKind(fromKind: ChipKind, toKind: ChipKind): ChipEdgeKind {
  if (
    (fromKind === "extract" || fromKind === "transform")
    && (toKind === "transform" || toKind === "load")
  ) {
    return "data";
  }
  return "then";
}

function incomingDataEdge(edges: ChipEdge[], chipId: string): ChipEdge | undefined {
  return edges.find((edge) => edge.to_chip_id === chipId && edge.kind === "data");
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
  pressed,
  separate,
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
  pressed?: boolean;
  separate?: boolean;
  draggable?: boolean;
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd?: () => void;
  onClick?: () => void;
}) {
  const [tipOpen, setTipOpen] = useState(false);

  return (
    <li
      className={cn("relative", separate && "is-sep")}
      onMouseEnter={() => setTipOpen(true)}
      onMouseLeave={() => setTipOpen(false)}
    >
      <button
        type="button"
        draggable={draggable && !disabled}
        disabled={disabled}
        aria-label={`${label}. ${hint}`}
        aria-pressed={pressed}
        className={cn("dock-btn", pressed && "is-active")}
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

function ChipLinkHandle({
  side,
  label,
  kind,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: {
  side: PortSide;
  label: string;
  kind: ChipEdgeKind;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerCancel?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className={cn("chip-link", `is-${side}`, `is-${kind}`)}
      aria-label={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <svg viewBox="0 0 18 14" aria-hidden="true">
        <path
          d="M2 7 H11"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
        <path
          d="M9 3 L15 7 L9 11"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

function EdgeWire({
  geo,
  kind,
  selected = false,
  preview = false,
  onClick,
}: {
  geo: EdgeGeometry;
  kind: ChipEdgeKind;
  selected?: boolean;
  preview?: boolean;
  onClick?: (event: ReactMouseEvent<SVGPathElement>) => void;
}) {
  const marks = preview ? [] : flowMarks(geo);
  return (
    <g className={cn("chip-wire", wireTone(kind), selected && "is-selected", preview && "is-preview")}>
      {onClick ? (
        <path
          d={geo.d}
          fill="none"
          stroke="transparent"
          strokeWidth={16}
          className="pointer-events-auto cursor-pointer"
          onClick={onClick}
        />
      ) : null}
      <path d={geo.d} fill="none" className="chip-wire-glow" />
      <path d={geo.d} fill="none" className="chip-wire-trace" />
      <path d={geo.d} fill="none" className="chip-wire-core" markerEnd={`url(#chip-wire-arrow-${kind})`} />
      <path d={geo.d} fill="none" className="chip-wire-flow" />
      {marks.map((mark, index) => (
        <path
          key={`${mark.x}-${mark.y}-${index}`}
          className="chip-wire-chevron"
          d="M -7 -4.2 L 0.4 0 L -7 4.2"
          transform={`translate(${mark.x} ${mark.y}) rotate(${mark.angle})`}
        />
      ))}
      <polygon
        className="chip-wire-node"
        points={`${geo.start.x},${geo.start.y - 4} ${geo.start.x + 4},${geo.start.y} ${geo.start.x},${geo.start.y + 4} ${geo.start.x - 4},${geo.start.y}`}
      />
    </g>
  );
}

function CollapsibleRailSection({
  title,
  hint,
  icon: Icon,
  open,
  onToggle,
  expandLabel,
  collapseLabel,
  children,
}: {
  title: string;
  hint?: string;
  icon: LucideIcon;
  open: boolean;
  onToggle: () => void;
  expandLabel: string;
  collapseLabel: string;
  children: ReactNode;
}) {
  return (
    <section className="workspace-rail-group border-b border-border/70 pb-3 last:border-b-0 last:pb-0">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left outline-none transition-colors hover:bg-subtle/80 focus-visible:ring-2 focus-visible:ring-accent/40"
        aria-expanded={open}
        aria-label={`${title} ${open ? collapseLabel : expandLabel}`}
        onClick={onToggle}
      >
        <Icon className="size-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text">{title}</span>
        <ChevronDown
          className={cn("size-3.5 shrink-0 text-text-tertiary transition-transform duration-200", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      {hint && open ? (
        <p className="mt-1 px-1 text-[11px] leading-4 text-text-tertiary">{hint}</p>
      ) : null}
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            className="overflow-hidden"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeInOut" }}
          >
            <div className="pt-2">{children}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

function LayerGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="workspace-rail-group">
      <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
        {title}
      </h3>
      <ul className="space-y-1">{children}</ul>
    </section>
  );
}

function LayerRow({
  active,
  icon: Icon,
  iconClassName,
  label,
  meta,
  onClick,
}: {
  active?: boolean;
  icon: LucideIcon;
  iconClassName?: string;
  label: string;
  meta?: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left outline-none transition-colors",
          active
            ? "bg-accent-subtle text-accent shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--theme-accent)_28%,transparent)]"
            : "hover:bg-subtle",
        )}
        onClick={onClick}
      >
        <span className={cn(
          "grid size-7 shrink-0 place-items-center rounded-lg",
          active ? "bg-surface" : "bg-subtle",
        )}>
          <Icon className={cn("size-3.5", iconClassName)} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text">{label}</span>
        {meta ? (
          <span className="shrink-0 rounded-full bg-subtle px-1.5 py-0.5 text-[10px] text-text-tertiary">
            {meta}
          </span>
        ) : null}
      </button>
    </li>
  );
}

function ChipPickerDialog({
  open,
  kind,
  chips,
  canvasChipIds,
  messages,
  onClose,
  onConfirm,
}: {
  open: boolean;
  kind: "extract" | "transform";
  chips: Chip[];
  canvasChipIds: Set<string>;
  messages: Messages;
  onClose: () => void;
  onConfirm: (chipIds: string[]) => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const options = useMemo(
    () => chips.filter((chip) => chip.kind === kind),
    [chips, kind],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((chip) => chip.name.toLowerCase().includes(needle));
  }, [options, query]);
  const title = kind === "extract"
    ? messages.workspace.pickExtractChip
    : messages.workspace.pickTransformChip;
  const emptyHint = kind === "extract"
    ? messages.workspace.emptyCatalogExtract
    : messages.workspace.emptyCatalogTransform;
  const RowIcon = kind === "extract" ? DatabaseZap : Workflow;
  const iconClassName = kind === "extract" ? "text-accent" : "text-success";
  const registerPath = kind === "extract" ? "/query" : "/transform/clean";

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIds([]);
  }, [open, kind]);

  function goRegister() {
    onClose();
    navigate(registerPath);
  }

  function toggleSelected(chipId: string) {
    setSelectedIds((current) =>
      current.includes(chipId)
        ? current.filter((id) => id !== chipId)
        : [...current, chipId],
    );
  }

  return (
    <AppDialog
      open={open}
      title={title}
      icon={<RowIcon className={cn("size-4", iconClassName)} aria-hidden="true" />}
      className="w-[min(30rem,94vw)]"
      minWidth={380}
      minHeight={380}
      hideHeaderClose
      onClose={onClose}
      headerExtra={(
        <Button
          type="button"
          variant="secondary"
          className="ml-auto h-7 gap-1 px-2 text-[11px] font-medium"
          onClick={goRegister}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          {messages.workspace.registerNewChip}
        </Button>
      )}
      footer={(
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-xs text-text-tertiary">
            {options.length > 0 && selectedIds.length > 0
              ? messages.workspace.pickChipSelected(selectedIds.length)
              : "\u00a0"}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="grid size-9 place-items-center rounded-lg text-text-secondary outline-none transition-colors hover:bg-subtle hover:text-text focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label={messages.common.cancel}
              title={messages.common.cancel}
              onClick={onClose}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
            {options.length > 0 ? (
              <button
                type="button"
                className="grid size-9 place-items-center rounded-lg text-accent outline-none transition-colors hover:bg-accent-subtle disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent/40"
                aria-label={messages.workspace.pickChipPlace}
                title={messages.workspace.pickChipPlace}
                disabled={selectedIds.length === 0}
                onClick={() => onConfirm(selectedIds)}
              >
                <Check className="size-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>
      )}
    >
      {options.length === 0 ? (
        <div className="flex min-h-[12rem] items-center justify-center px-8 py-10">
          <p className="text-center text-xs leading-5 text-text-tertiary">{emptyHint}</p>
        </div>
      ) : (
        <div className="flex min-h-[16rem] flex-col gap-4 px-5 py-4">
          <div className="flex flex-col gap-2">
            <p className="text-xs text-text-secondary">{messages.workspace.pickChipHint}</p>
            <div className="group flex h-9 items-center overflow-hidden rounded-lg border border-border bg-surface shadow-sm transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
              <span className="grid h-full w-9 shrink-0 place-items-center border-r border-border bg-subtle text-text-tertiary transition-colors group-focus-within:text-accent">
                <Search className="size-3.5" aria-hidden="true" />
              </span>
              <input
                type="search"
                className="min-w-0 flex-1 bg-transparent px-3 text-xs text-text outline-none placeholder:text-text-tertiary [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
                value={query}
                placeholder={messages.workspace.pickChipSearch}
                aria-label={messages.workspace.pickChipSearch}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>
          {filtered.length === 0 ? (
            <div className="flex flex-1 items-center justify-center py-8">
              <p className="text-xs text-text-tertiary">{messages.workspace.pickChipSearchEmpty}</p>
            </div>
          ) : (
            <ul className="scroll-pane max-h-[22rem] min-h-[10rem] flex-1 divide-y divide-border/50 overflow-y-auto rounded-xl border border-border/60">
              {filtered.map((chip) => {
                const selected = selectedIds.includes(chip.id);
                return (
                  <li key={chip.id}>
                    <button
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors outline-none",
                        selected
                          ? "bg-accent-subtle/80 hover:bg-accent-subtle"
                          : "hover:bg-subtle/70",
                        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40",
                      )}
                      aria-pressed={selected}
                      onClick={() => toggleSelected(chip.id)}
                    >
                      <span
                        className={cn(
                          "grid size-4 shrink-0 place-items-center rounded border transition-colors",
                          selected
                            ? "border-accent bg-accent text-white"
                            : "border-border bg-surface text-transparent",
                        )}
                        aria-hidden="true"
                      >
                        <Check className="size-3" />
                      </span>
                      <RowIcon className={cn("size-4 shrink-0", iconClassName)} aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{chip.name}</span>
                      {canvasChipIds.has(chip.id) ? (
                        <span className="shrink-0 text-[11px] text-text-tertiary">
                          {messages.workspace.chipOnCanvas}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </AppDialog>
  );
}

function WorkspaceLayers({
  chips,
  edges,
  chipId,
  selectedEdgeId,
  messages,
  emptyHint,
  open,
  onToggle,
  onSelectChip,
  onSelectEdge,
}: {
  chips: Chip[];
  edges: ChipEdge[];
  chipId?: string;
  selectedEdgeId: string | null;
  messages: Messages;
  emptyHint: string;
  open: boolean;
  onToggle: () => void;
  onSelectChip: (id: string) => void;
  onSelectEdge: (id: string) => void;
}) {
  const extracts = chips.filter((chip) => chip.kind === "extract");
  const transforms = chips.filter((chip) => chip.kind === "transform");
  const nameOf = (id: string) => chips.find((chip) => chip.id === id)?.name ?? id.slice(0, 8);
  const kindLabel = (kind: ChipEdgeKind) =>
    kind === "data"
      ? messages.workspace.edgeData
      : kind === "then"
        ? messages.workspace.edgeThen
        : messages.workspace.edgeOnError;

  const body = chips.length === 0 && edges.length === 0 ? (
    <p className="px-1 text-[12px] text-text-tertiary">{emptyHint}</p>
  ) : (
    <div className="flex flex-col gap-3">
      <LayerGroup title={messages.workspace.layerExtracts(extracts.length)}>
        {extracts.length === 0 ? (
          <li className="px-2 py-1 text-[12px] text-text-tertiary">{messages.workspace.emptyLayerGroup}</li>
        ) : (
          extracts.map((chip) => (
            <LayerRow
              key={chip.id}
              active={chip.id === chipId}
              icon={DatabaseZap}
              iconClassName="text-accent"
              label={chip.name}
              onClick={() => onSelectChip(chip.id)}
            />
          ))
        )}
      </LayerGroup>
      <LayerGroup title={messages.workspace.layerTransforms(transforms.length)}>
        {transforms.length === 0 ? (
          <li className="px-2 py-1 text-[12px] text-text-tertiary">{messages.workspace.emptyLayerGroup}</li>
        ) : (
          transforms.map((chip) => (
            <LayerRow
              key={chip.id}
              active={chip.id === chipId}
              icon={Workflow}
              iconClassName="text-success"
              label={chip.name}
              onClick={() => onSelectChip(chip.id)}
            />
          ))
        )}
      </LayerGroup>
      <LayerGroup title={messages.workspace.layerEdges(edges.length)}>
        {edges.length === 0 ? (
          <li className="px-2 py-1 text-[12px] text-text-tertiary">{messages.workspace.emptyLayerGroup}</li>
        ) : (
          edges.map((edge) => (
            <LayerRow
              key={edge.id}
              active={edge.id === selectedEdgeId}
              icon={Spline}
              iconClassName={
                edge.kind === "on_error"
                  ? "text-danger"
                  : edge.kind === "then"
                    ? "text-text-secondary"
                    : "text-accent"
              }
              label={`${nameOf(edge.from_chip_id)} → ${nameOf(edge.to_chip_id)}`}
              meta={kindLabel(edge.kind)}
              onClick={() => onSelectEdge(edge.id)}
            />
          ))
        )}
      </LayerGroup>
    </div>
  );

  return (
    <CollapsibleRailSection
      title={messages.workspace.layers}
      icon={Layers}
      open={open}
      onToggle={onToggle}
      expandLabel={messages.workspace.expandPanel}
      collapseLabel={messages.workspace.collapsePanel}
    >
      {body}
    </CollapsibleRailSection>
  );
}

function WorkspaceMinimap({
  chips,
  positions,
  scroll,
  view,
  label,
  onJump,
}: {
  chips: Chip[];
  positions: Record<string, Point>;
  scroll: Point;
  view: { width: number; height: number };
  label: string;
  onJump: (worldX: number, worldY: number) => void;
}) {
  const scale = Math.min(MINIMAP_W / CANVAS_W, MINIMAP_H / CANVAS_H);
  const mapW = CANVAS_W * scale;
  const mapH = CANVAS_H * scale;
  const viewLeft = scroll.x * scale;
  const viewTop = scroll.y * scale;
  const viewW = Math.min(mapW, view.width * scale);
  const viewH = Math.min(mapH, view.height * scale);

  function pointFromEvent(event: ReactPointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / mapW) * CANVAS_W,
      y: ((event.clientY - rect.top) / mapH) * CANVAS_H,
    };
  }

  return (
    <div
      className="workspace-minimap"
      role="navigation"
      aria-label={label}
      style={{ width: mapW, height: mapH }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const point = pointFromEvent(event);
        onJump(point.x, point.y);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const point = pointFromEvent(event);
        onJump(point.x, point.y);
      }}
    >
      <div className="workspace-minimap-world" aria-hidden="true">
        {chips.map((chip) => {
          const point = positions[chip.id];
          if (!point) return null;
          return (
            <span
              key={chip.id}
              className={cn(
                "workspace-minimap-chip",
                chip.kind === "extract" ? "is-extract" : "is-transform",
              )}
              style={{
                left: point.x * scale,
                top: point.y * scale,
                width: Math.max(3, NODE_W * scale),
                height: Math.max(3, NODE_H * scale),
              }}
            />
          );
        })}
        <span
          className="workspace-minimap-view"
          style={{ left: viewLeft, top: viewTop, width: viewW, height: viewH }}
        />
      </div>
    </div>
  );
}

export function WorkspacePage() {
  const { messages } = useLanguage();
  const navigate = useNavigate();
  const { workspaceId, chipId } = useParams<{ workspaceId: string; chipId: string }>();
  const currentWorkspaceRef = useRef(workspaceId);
  const logRequestRef = useRef(0);
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
  } | null>(null);
  currentWorkspaceRef.current = workspaceId;

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [folders, setFolders] = useState<WorkspaceFolder[]>([]);
  const [layersOpen, setLayersOpen] = useState(true);
  const [chips, setChips] = useState<Chip[]>([]);
  const [catalogChips, setCatalogChips] = useState<Chip[]>([]);
  const [edges, setEdges] = useState<ChipEdge[]>([]);
  const [runs, setRuns] = useState<ChipRun[]>([]);
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
  const [manageOpen, setManageOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [canvasView, setCanvasView] = useState({ width: 800, height: 600 });
  const [canvasScroll, setCanvasScroll] = useState({ x: 0, y: 0 });
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [selectedChipIds, setSelectedChipIds] = useState<string[]>([]);
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null);
  const [edgeTool, setEdgeTool] = useState<ChipEdgeKind>("data");
  const selectedChipIdsRef = useRef(selectedChipIds);
  selectedChipIdsRef.current = selectedChipIds;
  const [linking, setLinking] = useState<{
    fromId: string;
    kind: ChipEdgeKind;
    fromSide: PortSide;
    x: number;
    y: number;
  } | null>(null);
  const linkingRef = useRef(linking);
  linkingRef.current = linking;

  const [name, setName] = useState("");
  const [kind, setKind] = useState<ChipKind>("extract");
  const [mode, setMode] = useState("table");
  const [connectionId, setConnectionId] = useState("");
  const [database, setDatabase] = useState("");
  const [table, setTable] = useState("");
  const [sql, setSql] = useState("");
  const [delimiter, setDelimiter] = useState(",");
  const [hasHeader, setHasHeader] = useState(true);
  const [inputDatasetId, setInputDatasetId] = useState("");
  const [spec, setSpec] = useState(EMPTY_SPEC);
  const [pendingPlace, setPendingPlace] = useState<{
    kind: "extract" | "transform";
    point: Point;
  } | null>(null);
  const [chipNameError, setChipNameError] = useState("");
  positionsRef.current = positions;
  dirtyRef.current = dirty;
  busyRef.current = busy;

  const selectedWorkspace = workspaces.find((item) => item.id === workspaceId);
  const workspaceFolderPath = folderPathLabel(
    selectedWorkspace?.folder_id,
    folders,
    messages.workspace.pathRoot,
  );
  const workspaceName = selectedWorkspace?.name ?? messages.workspace.selectWorkspace;
  const selectedChip = chips.find((item) => item.id === chipId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const hasActiveRun = runs.some((run) => ACTIVE_STATUSES.has(run.status));
  const selectedRuns = useMemo(
    () => runs.filter((run) => run.chip_id === selectedChip?.id).slice(0, 5),
    [runs, selectedChip?.id],
  );
  const canvasWorld = useMemo(() => ({ width: CANVAS_W, height: CANVAS_H }), []);

  function resetChipForm() {
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

  function dropEdgeLocally(edgeId: string) {
    const nextEdges = edges.filter((edge) => edge.id !== edgeId);
    setEdges(nextEdges);
    setSelectedEdgeId((current) => (current === edgeId ? null : current));
    markDirty(chips, positionsRef.current, nextEdges);
  }

  function connectChips(fromId: string, toId: string, kindValue: ChipEdgeKind) {
    if (fromId === toId) return;
    const from = chips.find((chip) => chip.id === fromId);
    const to = chips.find((chip) => chip.id === toId);
    if (!from || !to || !workspaceId) return;
    const kind = kindValue === "data" ? defaultEdgeKind(from.kind, to.kind) === "data" ? "data" : "then" : kindValue;
    if (kind === "data" && defaultEdgeKind(from.kind, to.kind) !== "data") return;
    if (edges.some((edge) =>
      edge.from_chip_id === fromId && edge.to_chip_id === toId && edge.kind === kind
    )) {
      return;
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
    const nextEdges = [...edges, created];
    setEdges(nextEdges);
    setSelectedEdgeId(created.id);
    markDirty(chips, positionsRef.current, nextEdges);
  }

  function changeEdgeKind(edgeId: string, kindValue: ChipEdgeKind) {
    const current = edges.find((edge) => edge.id === edgeId);
    if (!current) return;
    const from = chips.find((chip) => chip.id === current.from_chip_id);
    const to = chips.find((chip) => chip.id === current.to_chip_id);
    if (!from || !to) return;
    if (kindValue === "data" && defaultEdgeKind(from.kind, to.kind) !== "data") return;
    const nextEdges = edges.map((edge) =>
      edge.id === edgeId ? { ...edge, kind: kindValue } : edge,
    );
    setEdges(nextEdges);
    markDirty(chips, positionsRef.current, nextEdges);
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
      workspaceApi.listFolders(),
      connectionApi.getConnections(),
      datasetApi.list(),
    ])
      .then(([workspaceResponse, folderResponse, connectionResponse, datasetResponse]) => {
        if (cancelled) return;
        setWorkspaces(workspaceResponse.workspaces);
        setFolders(folderResponse.folders);
        setConnections(connectionResponse.connections);
        setDatasets(datasetResponse.datasets);
        if (!workspaceId && workspaceResponse.workspaces.length > 0) {
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
      setChips([]);
      setEdges([]);
      setRuns([]);
      setPositions({});
      setSelectedChipIds([]);
      setSelectedEdgeId(null);
      rememberSaved([], {}, []);
      pendingViewRef.current = null;
      return;
    }
    let cancelled = false;
    pendingViewRef.current = null;
    setLoading(true);
    setError("");
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
        setSelectedEdgeId(null);
        rememberSaved(chipResponse.chips, nextPositions, nextEdges);
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
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await chipApi.listRuns(workspaceId, { silent: true });
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
    if (!selectedChip) {
      if (!chipId) resetChipForm();
      return;
    }
    const config = selectedChip.config;
    setName(selectedChip.name);
    setChipNameError("");
    setKind(selectedChip.kind);
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
  }, [selectedChip?.id, chipId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setLinking(null);
        setSelectedEdgeId(null);
        setSelectedChipIds([]);
        setMarquee(null);
        marqueeRef.current = null;
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (isEditableTarget(event.target)) return;
        if (selectedChipIdsRef.current.length > 0) {
          event.preventDefault();
          void deleteSelectedChips();
          return;
        }
        if (selectedEdgeId && !busyRef.current) {
          event.preventDefault();
          dropEdgeLocally(selectedEdgeId);
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
  }, [selectedEdgeId, workspaceId, chips]);

  function chipConfig(): ChipConfig {
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

  function isChipNameTaken(candidate: string, exceptId?: string) {
    const key = normalizeChipName(candidate);
    if (!key) return false;
    return chips.some(
      (chip) => chip.id !== exceptId && normalizeChipName(chip.name) === key,
    );
  }

  function applyChip(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceId || !selectedChip || kind === "load") return;
    try {
      const config = chipConfig();
      const nextName = name.trim();
      if (!nextName) return;
      if (isChipNameTaken(nextName, selectedChip.id)) {
        setChipNameError(messages.workspace.duplicateChipName);
        return;
      }
      setChipNameError("");
      const nextChips = chips.map((chip) =>
        chip.id === selectedChip.id ? { ...chip, name: nextName, config } : chip,
      );
      setChips(nextChips);
      markDirty(nextChips, positionsRef.current, edges);
      setError("");
    } catch (reason) {
      setError(`${messages.workspace.saveChipError}: ${String(reason)}`);
    }
  }

  function onChipNameChange(next: string) {
    setName(next);
    if (!selectedChip) return;
    const trimmed = next.trim();
    if (!trimmed) {
      setChipNameError("");
      return;
    }
    if (isChipNameTaken(trimmed, selectedChip.id)) {
      setChipNameError(messages.workspace.duplicateChipName);
      return;
    }
    setChipNameError("");
    if (trimmed === selectedChip.name) return;
    const nextChips = chips.map((chip) =>
      chip.id === selectedChip.id ? { ...chip, name: trimmed } : chip,
    );
    setChips(nextChips);
    markDirty(nextChips, positionsRef.current, edges);
  }

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
    setSelectedEdgeId(null);
    if (!workspaceId) return;
    if (placedIds.length === 1) {
      navigate(`/workspace/${workspaceId}/chips/${placedIds[0]}`);
    } else {
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
    savedRef.current = {
      chips: savedRef.current.chips.filter((item) => !dropSet.has(item.id)),
      positions: chipIdsToDrop.reduce(
        (positions, id) => omitPoint(positions, id),
        savedRef.current.positions,
      ),
      edges: savedRef.current.edges.filter((edge) =>
        !dropSet.has(edge.from_chip_id) && !dropSet.has(edge.to_chip_id),
      ),
    };
    for (const id of chipIdsToDrop) savedIdsRef.current.delete(id);
    markDirty(nextChips, nextPositions, nextEdges);
    setChips(nextChips);
    setRuns((current) => current.filter((run) => !dropSet.has(run.chip_id)));
    if (dragRef.current && dropSet.has(dragRef.current.id)) dragRef.current = null;
    setSelectedChipIds((current) => current.filter((id) => !dropSet.has(id)));
    if (selectedEdgeId && nextEdges.every((edge) => edge.id !== selectedEdgeId)) {
      setSelectedEdgeId(null);
    }
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
    setBusy(true);
    setError("");
    try {
      if (savedIdsRef.current.has(chip.id)) {
        await chipApi.remove(chip.id);
      }
      if (currentWorkspaceRef.current !== workspaceId) return;
      dropChipLocally(chip.id);
      if (chipId === chip.id && workspaceId) {
        navigate(`/workspace/${workspaceId}`);
      }
    } catch (reason) {
      if (currentWorkspaceRef.current === workspaceId) {
        setError(`${messages.workspace.deleteChipError}: ${String(reason)}`);
      }
    } finally {
      if (currentWorkspaceRef.current === workspaceId) setBusy(false);
    }
  }

  async function deleteSelectedChips() {
    const ids = selectedChipIdsRef.current.filter((id) =>
      chips.some((chip) => chip.id === id),
    );
    if (ids.length === 0 || busyRef.current) return;
    if (ids.length === 1) {
      const chip = chips.find((item) => item.id === ids[0]);
      if (chip) await deleteCanvasChip(chip);
      return;
    }
    const confirmed = await showConfirm(
      messages.workspace.deleteChipsTitle,
      messages.workspace.deleteChipsMessage(ids.length),
      { tone: "danger", confirmLabel: messages.common.delete },
    );
    if (!confirmed || currentWorkspaceRef.current !== workspaceId) return;
    setBusy(true);
    setError("");
    try {
      await Promise.all(
        ids
          .filter((id) => savedIdsRef.current.has(id))
          .map((id) => chipApi.remove(id)),
      );
      if (currentWorkspaceRef.current !== workspaceId) return;
      dropChipsLocally(ids);
      if (chipId && ids.includes(chipId) && workspaceId) {
        navigate(`/workspace/${workspaceId}`);
      }
    } catch (reason) {
      if (currentWorkspaceRef.current === workspaceId) {
        setError(`${messages.workspace.deleteChipError}: ${String(reason)}`);
      }
    } finally {
      if (currentWorkspaceRef.current === workspaceId) setBusy(false);
    }
  }

  async function saveCanvas() {
    if (!workspaceId) return;
    if (selectedChip && kind !== "load") {
      const nextName = name.trim();
      if (nextName && isChipNameTaken(nextName, selectedChip.id)) {
        setChipNameError(messages.workspace.duplicateChipName);
        return;
      }
    }
    const requestWorkspaceId = workspaceId;
    setBusy(true);
    setError("");
    try {
      let nextChips = chips;
      if (selectedChip && kind !== "load") {
        const config = chipConfig();
        nextChips = chips.map((chip) =>
          chip.id === selectedChip.id ? { ...chip, name: name.trim(), config } : chip,
        );
        setChips(nextChips);
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
        chips: nextChips.map((chip) => chip.id),
        edges: edges.map((edge) => {
          const fromPoint = positionsRef.current[edge.from_chip_id];
          const toPoint = positionsRef.current[edge.to_chip_id];
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
      if (currentWorkspaceRef.current !== requestWorkspaceId) return;
      const nextPositions = positionsFrom(response.chips, response.workspace.layout);
      const nextEdges = response.edges ?? response.workspace.edges ?? [];
      setWorkspaces((current) =>
        current.map((item) =>
          item.id === response.workspace.id ? response.workspace : item,
        ),
      );
      setChips(response.chips);
      setEdges(nextEdges);
      setPositions(nextPositions);
      rememberSaved(response.chips, nextPositions, nextEdges);
    } catch (reason) {
      if (currentWorkspaceRef.current === requestWorkspaceId) {
        setError(`${messages.workspace.saveChipError}: ${String(reason)}`);
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
    const saved = cloneCanvas(
      savedRef.current.chips,
      savedRef.current.positions,
      savedRef.current.edges,
    );
    setChips(saved.chips);
    setEdges(saved.edges);
    setPositions(saved.positions);
    setSelectedEdgeId(null);
    setDirty(false);
    setError("");
    if (chipId && !savedIdsRef.current.has(chipId) && workspaceId) {
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
      const [workspaceResponse, folderResponse, connectionResponse, datasetResponse] = await Promise.all([
        workspaceApi.list(),
        workspaceApi.listFolders(),
        connectionApi.getConnections(),
        datasetApi.list(),
      ]);
      if (refreshRequestRef.current !== requestId) return;
      setWorkspaces(workspaceResponse.workspaces);
      setFolders(folderResponse.folders);
      setConnections(connectionResponse.connections);
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

  async function runChip() {
    if (!selectedChip || selectedChip.kind === "load" || !workspaceId) return;
    const requestWorkspaceId = workspaceId;
    setBusy(true);
    setError("");
    try {
      const wired = Boolean(incomingDataEdge(edges, selectedChip.id));
      const request: RunChipRequest = {
        workspace_id: requestWorkspaceId,
        ...(selectedChip.kind === "transform" && inputDatasetId && !wired
          ? { input_dataset_id: inputDatasetId }
          : {}),
      };
      await chipApi.run(selectedChip.id, request);
      if (currentWorkspaceRef.current !== requestWorkspaceId) return;
      const response = await chipApi.listRuns(requestWorkspaceId);
      if (currentWorkspaceRef.current !== requestWorkspaceId) return;
      setRuns(response.runs);
    } catch (reason) {
      if (currentWorkspaceRef.current === requestWorkspaceId) {
        setError(`${messages.workspace.runChipError}: ${String(reason)}`);
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
      const response = await chipApi.getRunLogs(runId);
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
    const nextSelection = selectedChipIdsRef.current.includes(chip.id)
      ? selectedChipIdsRef.current
      : [chip.id];
    if (nextSelection.length === 1 && nextSelection[0] === chip.id) {
      setSelectedChipIds([chip.id]);
    }
    setSelectedEdgeId(null);
    const origins: Record<string, Point> = {};
    for (const id of nextSelection) {
      origins[id] = positionsRef.current[id] ?? { x: 56, y: 48 };
    }
    dragRef.current = {
      id: chip.id,
      dx: grab.x - node.x,
      dy: grab.y - node.y,
      startX: node.x,
      startY: node.y,
      moved: false,
      origins,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function finishNodeDrag(chipId: string, openInspector: boolean) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.id !== chipId) return;
    if (drag.moved) {
      markDirty(chips, positionsRef.current, edges);
      return;
    }
    if (!openInspector) return;
    setSelectedChipIds([chipId]);
    setSelectedEdgeId(null);
    navigate(`/workspace/${workspaceId}/chips/${chipId}`);
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
    setSelectedEdgeId(null);
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
    if (toId) connectChips(link.fromId, toId, link.kind);
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

    const grab = canvasPoint(canvas, event.clientX, event.clientY);
    marqueeRef.current = {
      pointerId: event.pointerId,
      x0: grab.x,
      y0: grab.y,
      x1: grab.x,
      y1: grab.y,
      moved: false,
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
    const active =
      (pan && pan.pointerId === event.pointerId) ||
      (box && box.pointerId === event.pointerId);
    if (active && pointerOutsideCanvas(canvas, event.clientX, event.clientY)) {
      cancelCanvasGesture(event.pointerId);
      return;
    }

    if (pan && pan.pointerId === event.pointerId) {
      const dx = event.clientX - pan.startX;
      const dy = event.clientY - pan.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) pan.moved = true;
      canvas.scrollLeft = pan.scrollLeft - dx;
      canvas.scrollTop = pan.scrollTop - dy;
      return;
    }

    if (!box || box.pointerId !== event.pointerId) return;
    scrollCanvasFromPointer(canvas, event.clientX, event.clientY);
    const grab = canvasPoint(canvas, event.clientX, event.clientY);
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
        setSelectedEdgeId(null);
        setSelectedChipIds([]);
        navigate(`/workspace/${workspaceId}`);
      }
      return;
    }

    const box = marqueeRef.current;
    if (!box || box.pointerId !== event.pointerId) return;
    marqueeRef.current = null;
    setMarquee(null);
    if (!box.moved) {
      setSelectedEdgeId(null);
      setSelectedChipIds([]);
      if (workspaceId) navigate(`/workspace/${workspaceId}`);
      return;
    }
    const picked = chips
      .filter((chip) => {
        const point = positionsRef.current[chip.id];
        return point ? chipInMarquee(point, box) : false;
      })
      .map((chip) => chip.id);
    setSelectedEdgeId(null);
    setSelectedChipIds(picked);
    if (picked.length === 1 && workspaceId) {
      navigate(`/workspace/${workspaceId}/chips/${picked[0]}`);
    } else if (workspaceId) {
      navigate(`/workspace/${workspaceId}`);
    }
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

  const wiredInput = selectedChip ? Boolean(incomingDataEdge(edges, selectedChip.id)) : false;
  const validExtract = connectionId && (mode === "table" ? table.trim() : sql.trim());
  const validTransform = spec.trim() && (wiredInput || inputDatasetId);
  const canSave = Boolean(selectedChip) && name.trim() && kind !== "load" &&
    (kind === "extract" ? Boolean(validExtract) : Boolean(validTransform));
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
      kind: "then" as const,
      label: messages.workspace.edgeThen,
      hint: messages.workspace.edgeThenHint,
      icon: ArrowRight,
    },
    {
      kind: "on_error" as const,
      label: messages.workspace.edgeOnError,
      hint: messages.workspace.edgeOnErrorHint,
      icon: CircleAlert,
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
              {error || pollError ? (
                <div role="alert" className="mb-3 rounded-xl border border-danger/30 bg-danger-subtle px-3 py-2 text-xs text-danger">
                  {error || pollError}
                </div>
              ) : null}

              <WorkspaceLayers
                chips={chips}
                edges={edges}
                chipId={chipId}
                selectedEdgeId={selectedEdgeId}
                messages={messages}
                emptyHint={workspaceId ? messages.workspace.emptyLayers : messages.workspace.noWorkspaces}
                open={layersOpen}
                onToggle={() => setLayersOpen((current) => !current)}
                onSelectChip={(id) => {
                  if (!workspaceId) return;
                  setSelectedEdgeId(null);
                  setSelectedChipIds([id]);
                  navigate(`/workspace/${workspaceId}/chips/${id}`);
                }}
                onSelectEdge={(id) => {
                  if (!workspaceId) return;
                  setSelectedEdgeId(id);
                  setSelectedChipIds([]);
                  navigate(`/workspace/${workspaceId}`);
                }}
              />

            {selectedEdge ? (
              <div className="mt-4 flex flex-col gap-3 border-t border-border/70 pt-4">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold text-text">{messages.workspace.edgeInspector}</h2>
                    <button
                      type="button"
                      className="grid size-8 shrink-0 place-items-center rounded-lg text-text-secondary outline-none transition-colors hover:bg-subtle hover:text-text focus-visible:ring-2 focus-visible:ring-accent/40"
                      aria-label={messages.common.close}
                      title={messages.common.close}
                      onClick={() => setSelectedEdgeId(null)}
                    >
                      <X className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                  <label className="flex flex-col gap-1.5 text-xs font-medium text-text-secondary">
                    {messages.workspace.edgeKind}
                    <Select
                      value={selectedEdge.kind}
                      options={[
                        { value: "data", label: messages.workspace.edgeData },
                        { value: "then", label: messages.workspace.edgeThen },
                        { value: "on_error", label: messages.workspace.edgeOnError },
                      ]}
                      onChange={(value) => changeEdgeKind(selectedEdge.id, value as ChipEdgeKind)}
                    />
                  </label>
                  <p className="text-xs text-text-secondary">{messages.workspace.edgeHint}</p>
                  <Button
                    type="button"
                    variant="quiet"
                    onClick={() => dropEdgeLocally(selectedEdge.id)}
                  >
                    {messages.workspace.deleteEdge}
                  </Button>
                </div>
            ) : null}

            {selectedChip ? (
              <form className="mt-4 flex flex-col gap-3 border-t border-border/70 pt-4" onSubmit={applyChip}>
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold text-text">{messages.workspace.inspector}</h2>
                    <button
                      type="button"
                      className="grid size-8 shrink-0 place-items-center rounded-lg text-text-secondary outline-none transition-colors hover:bg-subtle hover:text-text focus-visible:ring-2 focus-visible:ring-accent/40"
                      aria-label={messages.common.close}
                      title={messages.common.close}
                      onClick={() => navigate(`/workspace/${workspaceId}`)}
                    >
                      <X className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                  <label className="flex flex-col gap-1.5 text-xs font-medium text-text-secondary">
                    {messages.workspace.chipName}
                    <input
                      className={cn("field-control", chipNameError && "border-danger")}
                      value={name}
                      required
                      aria-invalid={Boolean(chipNameError)}
                      onChange={(event) => onChipNameChange(event.target.value)}
                    />
                    {chipNameError ? (
                      <span className="text-[11px] font-normal text-danger">{chipNameError}</span>
                    ) : null}
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
                        {wiredInput ? (
                          <p className="text-xs font-normal text-text-secondary">
                            {messages.workspace.inputFromEdge}
                          </p>
                        ) : (
                          <Select
                            value={inputDatasetId}
                            placeholder={messages.workspace.selectDataset}
                            options={datasets
                              .filter((dataset) => dataset.available && dataset.workspace_id === workspaceId)
                              .map((dataset) => ({ value: dataset.id, label: dataset.filename }))}
                            onChange={setInputDatasetId}
                          />
                        )}
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
                    <Button type="submit" variant="primary" disabled={busy || !name.trim() || Boolean(chipNameError) || kind === "load"}>
                      {messages.workspace.applyChip}
                    </Button>
                    <Button
                      type="button"
                      disabled={busy || !selectedChip.active || !canSave || dirty || !savedIdsRef.current.has(selectedChip.id)}
                      title={dirty || !savedIdsRef.current.has(selectedChip.id) ? messages.workspace.saveFirst : undefined}
                      onClick={() => void runChip()}
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
                          <li key={run.id} className="rounded-xl border border-border bg-raised px-2.5 py-2">
                            <div className="flex items-center justify-between gap-2">
                              <StatusPill value={run.status} />
                              <span className="technical text-[11px] text-text-tertiary">{fmtWhen(run.created_at)}</span>
                            </div>
                            {run.error_message ? (
                              <p className="mt-1 truncate text-[11px] text-danger" title={run.error_message}>
                                {run.error_message}
                              </p>
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
                        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-subtle p-2.5 text-[11px] text-text-secondary">
                          {runLog.text || messages.workspace.noRunLog}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}
              </form>
            ) : null}
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
                  selectedChip
                    ? selectedChip.kind === "extract"
                      ? "text-accent"
                      : "text-success"
                    : "text-text",
                )}
              >
                {selectedChip ? (
                  selectedChip.kind === "transform" ? (
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
                  {selectedChip
                    ? selectedWorkspace?.name ?? messages.workspace.title
                    : messages.workspace.title}
                </p>
                <h1 className="mt-0.5 min-w-0 truncate text-sm font-semibold tracking-[-0.015em] text-text">
                  {selectedChip
                    ? name.trim() || selectedChip.name
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
            if (
              panRef.current?.pointerId === event.pointerId ||
              marqueeRef.current?.pointerId === event.pointerId
            ) {
              cancelCanvasGesture(event.pointerId);
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
            {(["data", "then", "on_error"] as const).map((kindValue) => (
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
                selected={edge.id === selectedEdgeId}
                onClick={(event) => {
                  event.stopPropagation();
                  setSelectedEdgeId(edge.id);
                  setSelectedChipIds([]);
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
              aria-current={chip.id === chipId ? "true" : undefined}
              aria-label={chip.name}
              className={cn(
                "workspace-node absolute flex h-[96px] w-[100px] cursor-grab select-none flex-col items-center gap-0.5 px-1.5 pb-1.5 pt-4 text-center active:cursor-grabbing",
                (chip.id === chipId || selectedChipIds.includes(chip.id)) && "is-selected",
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
                  navigate(`/workspace/${workspaceId}/chips/${chip.id}`);
                }
              }}
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
                {latest ? <StatusPill value={latest.status} /> : null}
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

      <ChipPickerDialog
        open={Boolean(pendingPlace)}
        kind={pendingPlace?.kind ?? "extract"}
        chips={catalogChips}
        canvasChipIds={new Set(chips.map((chip) => chip.id))}
        messages={messages}
        onClose={cancelPlaceChip}
        onConfirm={confirmCatalogChips}
      />

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
          setManageOpen(false);
          if (id) navigate(`/workspace/${id}`);
          else navigate("/workspace");
        }}
      />
    </>
  );
}
