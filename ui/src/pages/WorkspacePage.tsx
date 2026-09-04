import { DragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useNavigate, useParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { AppWindow, ArrowRight, CheckCircle2, ChevronDown, CircleAlert, DatabaseZap, Folder, FolderOpen, Layers, Pencil, Play, Puzzle, RefreshCw, Save, Settings2, Spline, Workflow, X, type LucideIcon } from "lucide-react";
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
import type { Messages } from "@/i18n/ko";
import { cn } from "@/lib/cn";
import { layout } from "@/lib/layout";
import { showConfirm, toastError, toastSuccess } from "@/lib/notifications";
import { datasetApi } from "@/services/transform/datasetApi";
import { chipApi } from "@/services/chips/chipApi";
import { workspaceApi } from "@/services/workspace/workspaceApi";
import type { Dataset } from "@/types/dataset";
import type { Chip, ChipEdge, ChipEdgeKind, ChipKind, ChipRun } from "@/types/chip";
import { DRAFT_CHIP_ID_PREFIX, isDraftChipId } from "@/types/chip";
import type { Workspace, WorkspaceFolder, WorkspaceLayout } from "@/types/workspace";

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const TOOL_KIND = "application/x-bintl-tool";

function chipKindLabel(kind: ChipKind, messages: Messages) {
  if (kind === "extract") return messages.workspace.extract;
  if (kind === "transform") return messages.workspace.transform;
  return messages.workspace.load;
}

function chipRunOrder(chips: Chip[], edges: ChipEdge[]): Chip[] | null {
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const chip of chips) {
    incoming.set(chip.id, 0);
    outgoing.set(chip.id, []);
  }
  for (const edge of edges) {
    if (edge.kind === "on_error") continue;
    if (!incoming.has(edge.from_chip_id) || !incoming.has(edge.to_chip_id)) continue;
    outgoing.get(edge.from_chip_id)?.push(edge.to_chip_id);
    incoming.set(edge.to_chip_id, (incoming.get(edge.to_chip_id) ?? 0) + 1);
  }
  const ready = chips.filter((chip) => incoming.get(chip.id) === 0).map((chip) => chip.id);
  const ordered: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const left = (incoming.get(next) ?? 1) - 1;
      incoming.set(next, left);
      if (left === 0) ready.push(next);
    }
  }
  if (ordered.length !== chips.length) return null;
  const byId = new Map(chips.map((chip) => [chip.id, chip]));
  return ordered.map((id) => byId.get(id)!);
}
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

function clampMarqueePoint(point: Point): Point {
  return {
    x: Math.max(0, Math.min(point.x, CANVAS_W)),
    y: Math.max(0, Math.min(point.y, CANVAS_H)),
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

function pointInMarqueeArea(
  point: Point,
  area: { x: number; y: number; w: number; h: number },
) {
  return (
    point.x >= area.x
    && point.x <= area.x + area.w
    && point.y >= area.y
    && point.y <= area.y + area.h
  );
}

function cubicPoint(t: number, p0: Point, p1: Point, p2: Point, p3: Point): Point {
  const u = 1 - t;
  const uu = u * u;
  const tt = t * t;
  return {
    x: uu * u * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + tt * t * p3.x,
    y: uu * u * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + tt * t * p3.y,
  };
}

/** True when the wire path intersects (or sits inside) the marquee rectangle. */
function edgeInMarquee(from: Point, to: Point, box: MarqueeBox): boolean {
  const geo = edgeGeometry(from, to);
  const area = normalizeMarquee(box);
  const xs = [geo.start.x, geo.end.x, geo.c1.x, geo.c2.x];
  const ys = [geo.start.y, geo.end.y, geo.c1.y, geo.c2.y];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (
    maxX < area.x
    || minX > area.x + area.w
    || maxY < area.y
    || minY > area.y + area.h
  ) {
    return false;
  }
  const samples = 24;
  for (let i = 0; i <= samples; i += 1) {
    if (pointInMarqueeArea(cubicPoint(i / samples, geo.start, geo.c1, geo.c2, geo.end), area)) {
      return true;
    }
  }
  return false;
}

function roundPoint(point: Point): Point {
  return { x: Math.round(point.x), y: Math.round(point.y) };
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
  // Keep scrolling while the pointer is past the viewport edge (marquee/pan outside).
  if (clientX >= rect.right - CANVAS_EDGE) dx = CANVAS_SCROLL_STEP;
  else if (clientX <= rect.left + CANVAS_EDGE) dx = -CANVAS_SCROLL_STEP;
  if (clientY >= rect.bottom - CANVAS_EDGE) dy = CANVAS_SCROLL_STEP;
  else if (clientY <= rect.top + CANVAS_EDGE) dy = -CANVAS_SCROLL_STEP;
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

function wireTone(kind: ChipEdgeKind): "is-data" | "is-success" | "is-error" | "is-always" {
  if (kind === "on_error") return "is-error";
  if (kind === "on_success") return "is-success";
  if (kind === "always") return "is-always";
  return "is-data";
}

/** Data wires carry a dataset: extract/transform → transform/load only. */
function canHaveDataEdge(fromKind: ChipKind, toKind: ChipKind): boolean {
  return (
    (fromKind === "extract" || fromKind === "transform")
    && (toKind === "transform" || toKind === "load")
  );
}

function chipFixedInputId(chip: Chip): string {
  const value = chip.config.input_dataset_id;
  return typeof value === "string" ? value.trim() : "";
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
  selected,
  icon: Icon,
  iconClassName,
  label,
  meta,
  onClick,
  onEdit,
  editTitle,
}: {
  selected?: boolean;
  icon: LucideIcon;
  iconClassName?: string;
  label: string;
  meta?: string;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onEdit?: () => void;
  editTitle?: string;
}) {
  return (
    <li>
      <div
        className={cn(
          "flex items-center gap-0.5 rounded-xl pr-1 outline-none transition-colors",
          selected
            ? "bg-accent-subtle text-accent shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--theme-accent)_28%,transparent)]"
            : "hover:bg-subtle",
        )}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
          onClick={onClick}
        >
          <span className={cn(
            "grid size-7 shrink-0 place-items-center rounded-lg",
            selected ? "bg-surface" : "bg-subtle",
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
        {onEdit ? (
          <div className="flex shrink-0 items-center gap-0.5 pr-0.5">
            <button
              type="button"
              className="grid size-7 place-items-center rounded-lg text-text-tertiary outline-none transition-colors hover:bg-surface hover:text-text focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45"
              aria-label={editTitle}
              title={editTitle}
              onClick={(event) => {
                event.stopPropagation();
                onEdit();
              }}
            >
              <Pencil className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function WorkspaceLayers({
  chips,
  edges,
  selectedChipIds,
  selectedEdgeIds,
  messages,
  emptyHint,
  open,
  onToggle,
  onSelectChip,
  onSelectEdge,
  onSelectAll,
  onDeleteSelected,
  onEditChip,
}: {
  chips: Chip[];
  edges: ChipEdge[];
  selectedChipIds: string[];
  selectedEdgeIds: string[];
  messages: Messages;
  emptyHint: string;
  open: boolean;
  onToggle: () => void;
  onSelectChip: (id: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onSelectEdge: (id: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onSelectAll: (checked: boolean) => void;
  onDeleteSelected: () => void;
  onEditChip: (chip: Chip) => void;
}) {
  const extracts = chips.filter((chip) => chip.kind === "extract");
  const transforms = chips.filter((chip) => chip.kind === "transform");
  const allChipIds = chips.map((chip) => chip.id);
  const allEdgeIds = edges.map((edge) => edge.id);
  const allLayersSelected = (allChipIds.length + allEdgeIds.length) > 0
    && allChipIds.every((id) => selectedChipIds.includes(id))
    && allEdgeIds.every((id) => selectedEdgeIds.includes(id));
  const someLayersSelected = selectedChipIds.length > 0 || selectedEdgeIds.length > 0;
  const nameOf = (id: string) => chips.find((chip) => chip.id === id)?.name ?? id.slice(0, 8);
  const kindLabel = (kind: ChipEdgeKind) => {
    if (kind === "data") return messages.workspace.edgeData;
    if (kind === "on_success") return messages.workspace.edgeOnSuccess;
    if (kind === "on_error") return messages.workspace.edgeOnError;
    return messages.workspace.edgeAlways;
  };

  const body = chips.length === 0 && edges.length === 0 ? (
    <p className="px-1 text-[12px] text-text-tertiary">{emptyHint}</p>
  ) : (
    <div className="flex flex-col gap-3">
      {chips.length > 0 || edges.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <label className="flex min-w-0 items-center gap-2 text-xs text-text-secondary">
            <input
              type="checkbox"
              className="size-3.5 shrink-0 rounded border-border accent-accent"
              checked={allLayersSelected}
              aria-label={messages.workspace.selectAll}
              onChange={(event) => onSelectAll(event.target.checked)}
            />
            <span className="truncate">{messages.workspace.selectAll}</span>
          </label>
          <Button
            type="button"
            variant="quiet"
            className="h-7 shrink-0 px-2 text-[11px]"
            disabled={!someLayersSelected}
            onClick={onDeleteSelected}
          >
            {messages.workspace.deleteSelected}
          </Button>
        </div>
      ) : null}
      {chips.length > 0 || edges.length > 0 ? (
        <p className="px-1 text-[11px] leading-4 text-text-tertiary">{messages.workspace.layerSelectHint}</p>
      ) : null}
      <LayerGroup title={messages.workspace.layerExtracts(extracts.length)}>
        {extracts.length === 0 ? (
          <li className="px-2 py-1 text-[12px] text-text-tertiary">{messages.workspace.emptyLayerGroup}</li>
        ) : (
          extracts.map((chip) => (
            <LayerRow
              key={chip.id}
              selected={selectedChipIds.includes(chip.id)}
              icon={DatabaseZap}
              iconClassName="text-accent"
              label={chip.name}
              onClick={(event) => onSelectChip(chip.id, event)}
              editTitle={messages.workspace.chipMenuProperties}
              onEdit={() => onEditChip(chip)}
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
              selected={selectedChipIds.includes(chip.id)}
              icon={Workflow}
              iconClassName="text-success"
              label={chip.name}
              onClick={(event) => onSelectChip(chip.id, event)}
              editTitle={messages.workspace.chipMenuProperties}
              onEdit={() => onEditChip(chip)}
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
              selected={selectedEdgeIds.includes(edge.id)}
              icon={Spline}
              iconClassName={
                edge.kind === "on_error"
                  ? "text-danger"
                  : edge.kind === "on_success"
                    ? "text-success"
                    : edge.kind === "always"
                      ? "text-text-secondary"
                      : "text-accent"
              }
              label={`${nameOf(edge.from_chip_id)} → ${nameOf(edge.to_chip_id)}`}
              meta={kindLabel(edge.kind)}
              onClick={(event) => onSelectEdge(edge.id, event)}
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
    messages.workspace.pathRoot,
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
    const qs = new URLSearchParams({ workspace: workspaceId, chip: chip.id });
    const bound = chip.binding?.ref_kind === "transform" ? chip.binding.ref_id : undefined;
    return bound ? `/transform/${bound}?${qs}` : `/transform?${qs}`;
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
    if (!additive) {
      setSelectedChipIds([chip.id]);
      setSelectedEdgeIds([]);
    } else if (!wasSelected) {
      setSelectedChipIds([...selectedChipIdsRef.current, chip.id]);
    }
    const dragIds = additive && wasSelected
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
