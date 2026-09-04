import type { Messages } from "@/i18n/ko";
import type { Chip, ChipEdge, ChipEdgeKind, ChipKind } from "@/types/chip";
import type { WorkspaceFolder, WorkspaceLayout } from "@/types/workspace";

export const ACTIVE_STATUSES = new Set(["queued", "running"]);
export const TOOL_KIND = "application/x-bintl-tool";

export function chipKindLabel(kind: ChipKind, messages: Messages) {
  if (kind === "extract") return messages.workspace.extract;
  if (kind === "transform") return messages.workspace.transform;
  return messages.workspace.load;
}

export function chipRunOrder(chips: Chip[], edges: ChipEdge[]): Chip[] | null {
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
export const NODE_W = 100;
export const NODE_H = 96;
export const CHIP_PLACE_GAP = 28;
export const CANVAS_W = 3200;
export const CANVAS_H = 2200;
export const CANVAS_EDGE = 56;
export const CANVAS_SCROLL_STEP = 18;
export const MINIMAP_W = 168;
export const MINIMAP_H = 116;

export type Point = { x: number; y: number };
export type CanvasSnapshot = { chips: Chip[]; positions: Record<string, Point>; edges: ChipEdge[] };

export function cloneCanvas(
  chips: Chip[],
  positions: Record<string, Point>,
  edges: ChipEdge[],
): CanvasSnapshot {
  return JSON.parse(JSON.stringify({ chips, positions, edges })) as CanvasSnapshot;
}

export function nodesFromLayout(layout?: WorkspaceLayout): Record<string, Point> {
  return layout?.nodes ?? {};
}

export function fallbackPoint(index: number): Point {
  return { x: 96 + (index % 5) * 128, y: 48 + Math.floor(index / 5) * 112 };
}

export function clampPoint(point: Point, bounds: { width: number; height: number } = { width: CANVAS_W, height: CANVAS_H }): Point {
  return {
    x: Math.max(16, Math.min(point.x, Math.max(16, bounds.width - NODE_W - 16))),
    y: Math.max(16, Math.min(point.y, Math.max(16, bounds.height - NODE_H - 16))),
  };
}

export function canvasPoint(canvas: HTMLElement, clientX: number, clientY: number): Point {
  const rect = canvas.getBoundingClientRect();
  return {
    x: clientX - rect.left + canvas.scrollLeft,
    y: clientY - rect.top + canvas.scrollTop,
  };
}

export function clampMarqueePoint(point: Point): Point {
  return {
    x: Math.max(0, Math.min(point.x, CANVAS_W)),
    y: Math.max(0, Math.min(point.y, CANVAS_H)),
  };
}

export function pointerOutsideCanvas(canvas: HTMLElement, clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect();
  return clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom;
}

export function releasePointer(target: Element, pointerId: number) {
  if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
}

export type MarqueeBox = { x0: number; y0: number; x1: number; y1: number };

export function normalizeMarquee(box: MarqueeBox) {
  return {
    x: Math.min(box.x0, box.x1),
    y: Math.min(box.y0, box.y1),
    w: Math.abs(box.x1 - box.x0),
    h: Math.abs(box.y1 - box.y0),
  };
}

export function chipInMarquee(point: Point, box: MarqueeBox): boolean {
  const area = normalizeMarquee(box);
  return (
    point.x < area.x + area.w &&
    point.x + NODE_W > area.x &&
    point.y < area.y + area.h &&
    point.y + NODE_H > area.y
  );
}

export function pointInMarqueeArea(
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

export function cubicPoint(t: number, p0: Point, p1: Point, p2: Point, p3: Point): Point {
  const u = 1 - t;
  const uu = u * u;
  const tt = t * t;
  return {
    x: uu * u * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + tt * t * p3.x,
    y: uu * u * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + tt * t * p3.y,
  };
}

/** True when the wire path intersects (or sits inside) the marquee rectangle. */
export function edgeInMarquee(from: Point, to: Point, box: MarqueeBox): boolean {
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

export function roundPoint(point: Point): Point {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

export function folderPathLabel(
  folderId: string | null | undefined,
  folders: WorkspaceFolder[],
  topLevelLabel: string,
): string {
  const segments: string[] = [];
  let cursor: string | null = folderId ?? null;
  while (cursor) {
    const folder = folders.find((item) => item.id === cursor);
    if (!folder) break;
    segments.push(folder.name);
    cursor = folder.parent_id;
  }
  return segments.length > 0 ? segments.reverse().join("/") : topLevelLabel;
}


export function scrollCanvasFromPointer(canvas: HTMLElement, clientX: number, clientY: number) {
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

export function omitPoint(positions: Record<string, Point>, id: string): Record<string, Point> {
  const next = { ...positions };
  delete next[id];
  return next;
}

export type PortSide = "left" | "right" | "top" | "bottom";

export type EdgeGeometry = {
  d: string;
  start: Point;
  end: Point;
  c1: Point;
  c2: Point;
  fromSide: PortSide;
  toSide: PortSide;
};

export function chipCenter(point: Point): Point {
  return { x: point.x + NODE_W / 2, y: point.y + NODE_H / 2 };
}

export function portPoint(chip: Point, side: PortSide): Point {
  if (side === "top") return { x: chip.x + NODE_W / 2, y: chip.y };
  if (side === "bottom") return { x: chip.x + NODE_W / 2, y: chip.y + NODE_H };
  return {
    x: side === "right" ? chip.x + NODE_W : chip.x,
    y: chip.y + NODE_H / 2,
  };
}

export function oppositeSide(side: PortSide): PortSide {
  if (side === "left") return "right";
  if (side === "right") return "left";
  if (side === "top") return "bottom";
  return "top";
}

export function asPortSide(value: string, fallback: PortSide = "right"): PortSide {
  if (value === "left" || value === "right" || value === "top" || value === "bottom") return value;
  return fallback;
}

export function routeSides(from: Point, to: Point): { fromSide: PortSide; toSide: PortSide } {
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

export function exitControl(point: Point, side: PortSide, dist: number): Point {
  if (side === "top") return { x: point.x, y: point.y - dist };
  if (side === "bottom") return { x: point.x, y: point.y + dist };
  return {
    x: side === "right" ? point.x + dist : point.x - dist,
    y: point.y,
  };
}

export function cubicPath(start: Point, c1: Point, c2: Point, end: Point): string {
  return `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
}

export function controlDistance(start: Point, end: Point) {
  return Math.max(64, Math.hypot(end.x - start.x, end.y - start.y) * 0.42);
}

export function edgeGeometry(from: Point, to: Point): EdgeGeometry {
  const { fromSide, toSide } = routeSides(from, to);
  const start = portPoint(from, fromSide);
  const end = portPoint(to, toSide);
  const dist = controlDistance(start, end);
  const c1 = exitControl(start, fromSide, dist);
  const c2 = exitControl(end, toSide, dist);
  return { d: cubicPath(start, c1, c2, end), start, end, c1, c2, fromSide, toSide };
}

export function previewGeometry(from: Point, cursor: Point, fromSide: PortSide): EdgeGeometry {
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

export function cubicAt(start: Point, c1: Point, c2: Point, end: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * start.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x,
    y: u * u * u * start.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y,
  };
}

export function cubicTangent(start: Point, c1: Point, c2: Point, end: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: 3 * u * u * (c1.x - start.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (end.x - c2.x),
    y: 3 * u * u * (c1.y - start.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (end.y - c2.y),
  };
}

export function flowMarks(geo: EdgeGeometry): Array<Point & { angle: number }> {
  return [0.34, 0.52, 0.7].map((t) => {
    const point = cubicAt(geo.start, geo.c1, geo.c2, geo.end, t);
    const tangent = cubicTangent(geo.start, geo.c1, geo.c2, geo.end, t);
    return {
      ...point,
      angle: (Math.atan2(tangent.y, tangent.x) * 180) / Math.PI,
    };
  });
}

export function wireTone(kind: ChipEdgeKind): "is-data" | "is-success" | "is-error" | "is-always" {
  if (kind === "on_error") return "is-error";
  if (kind === "on_success") return "is-success";
  if (kind === "always") return "is-always";
  return "is-data";
}

/** Data wires carry a dataset: extract/transform → transform/load only. */
export function canHaveDataEdge(fromKind: ChipKind, toKind: ChipKind): boolean {
  return (
    (fromKind === "extract" || fromKind === "transform")
    && (toKind === "transform" || toKind === "load")
  );
}

export function chipFixedInputId(chip: Chip): string {
  const value = chip.config.input_dataset_id;
  return typeof value === "string" ? value.trim() : "";
}

