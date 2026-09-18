import type { Messages } from "@/i18n/ko";
import type { Chip, ChipEdge, ChipEdgeKind, ChipKind } from "@/types/chip";
import type { WorkspaceFolder, WorkspaceLayout } from "@/types/workspace";

export const ACTIVE_STATUSES = new Set(["queued", "running"]);
export const TOOL_KIND = "application/x-bintl-tool";
export const PINNED_WORKSPACE_KEY = "bintl.canvas.pinned-workspace";

export function storedPinnedWorkspace(): string | null {
  try {
    return localStorage.getItem(PINNED_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

export function chipKindLabel(kind: ChipKind, messages: Messages) {
  if (kind === "extract") return messages.workspace.extract;
  if (kind === "transform") return messages.workspace.transform;
  if (kind === "load") return messages.workspace.load;
  if (kind === "sql") return messages.workspace.sql;
  if (kind === "serve") return messages.workspace.serve;
  if (kind === "script") return messages.workspace.script;
  return messages.workspace.validation;
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

/** ponytail: in-memory cap. Raise if long edit sessions start dropping early undos. */
export const CANVAS_UNDO_LIMIT = 50;

export function appendCanvasUndo(
  stack: CanvasSnapshot[],
  snapshot: CanvasSnapshot,
  limit = CANVAS_UNDO_LIMIT,
): CanvasSnapshot[] {
  const last = stack[stack.length - 1];
  if (last && JSON.stringify(last) === JSON.stringify(snapshot)) return stack;
  if (stack.length < limit) return [...stack, snapshot];
  return [...stack.slice(stack.length - limit + 1), snapshot];
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

export function canvasPoint(
  canvas: HTMLElement,
  clientX: number,
  clientY: number,
  zoom = 1,
): Point {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left + canvas.scrollLeft) / zoom,
    y: (clientY - rect.top + canvas.scrollTop) / zoom,
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

/** Data wires carry a materialized dataset into transform, load, or validation. */
export function canHaveDataEdge(fromKind: ChipKind, toKind: ChipKind): boolean {
  if (toKind === "validation") {
    return fromKind === "extract" || fromKind === "transform" || fromKind === "load" || fromKind === "script";
  }
  return (
    (fromKind === "extract" || fromKind === "transform" || fromKind === "script")
    && (toKind === "transform" || toKind === "load" || toKind === "serve" || toKind === "script")
  );
}

/** Control wires set run order. Sinks cannot feed the ETL pipeline; SQL is the sequencing hatch. */
export function canHaveControlEdge(fromKind: ChipKind, toKind: ChipKind): boolean {
  if (fromKind === "load") return toKind === "load" || toKind === "validation" || toKind === "sql";
  if (fromKind === "validation" || fromKind === "serve") return toKind === "sql";
  if (toKind === "extract") return fromKind === "extract" || fromKind === "sql";
  return true;
}

export type EdgeConnectIssue =
  | "self"
  | "kind"
  | "duplicate"
  | "cycle"
  | "shortcut"
  | "error-data"
  | "inputs";

export function edgeIssueMessage(issue: EdgeConnectIssue, kind: ChipEdgeKind, messages: Messages) {
  if (issue === "kind") {
    return kind === "data" ? messages.workspace.dataEdgeInvalidPair : messages.workspace.controlEdgeInvalidPair;
  }
  if (issue === "duplicate") return messages.workspace.edgeAlreadySame;
  if (issue === "cycle") return messages.workspace.edgeCycleError;
  if (issue === "shortcut") return messages.workspace.shortcutEdge;
  if (issue === "error-data") return messages.workspace.errorEdgeIntoConsumer;
  if (issue === "inputs") return messages.workspace.tooManyDataInputs;
  return messages.workspace.dataEdgeInvalidPair;
}

const FLOW_KINDS = new Set<ChipEdgeKind>(["data", "on_success", "always"]);
const ALL_KINDS = new Set<ChipEdgeKind>(["data", "on_success", "on_error", "always"]);

function pairKey(fromId: string, toId: string) {
  return `${fromId}\0${toId}`;
}

function hasDataEdge(edges: ChipEdge[], fromId: string, toId: string) {
  return edges.some((edge) =>
    edge.kind === "data" && edge.from_chip_id === fromId && edge.to_chip_id === toId,
  );
}

function pathExists(
  edges: ChipEdge[],
  fromId: string,
  toId: string,
  kinds: Set<ChipEdgeKind> = FLOW_KINDS,
) {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!kinds.has(edge.kind)) continue;
    const list = outgoing.get(edge.from_chip_id) ?? [];
    list.push(edge.to_chip_id);
    outgoing.set(edge.from_chip_id, list);
  }
  const seen = new Set([fromId]);
  const queue = [fromId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of outgoing.get(current) ?? []) {
      if (next === toId) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

function dataDependsOn(edges: ChipEdge[], nodeId: string, ancestorId: string) {
  const seen = new Set<string>();
  const walk = (id: string): boolean => {
    if (!seen.add(id)) return false;
    for (const edge of edges) {
      if (edge.kind !== "data" || edge.to_chip_id !== id) continue;
      if (edge.from_chip_id === ancestorId) return true;
      if (walk(edge.from_chip_id)) return true;
    }
    return false;
  };
  return walk(nodeId);
}

export function graphHasCycle(edges: ChipEdge[]) {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from_chip_id) ?? [];
    list.push(edge.to_chip_id);
    outgoing.set(edge.from_chip_id, list);
    if (!outgoing.has(edge.to_chip_id)) outgoing.set(edge.to_chip_id, []);
  }
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): boolean => {
    const current = state.get(id);
    if (current === 1) return true;
    if (current === 2) return false;
    state.set(id, 1);
    for (const next of outgoing.get(id) ?? []) {
      if (visit(next)) return true;
    }
    state.set(id, 2);
    return false;
  };
  return [...outgoing.keys()].some((id) => visit(id));
}

function indirectPathExists(
  edges: ChipEdge[],
  fromId: string,
  toId: string,
  kinds: Set<ChipEdgeKind> = FLOW_KINDS,
) {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!kinds.has(edge.kind)) continue;
    const list = outgoing.get(edge.from_chip_id) ?? [];
    list.push(edge.to_chip_id);
    outgoing.set(edge.from_chip_id, list);
  }
  const seen = new Set([fromId]);
  const queue: string[] = [];
  for (const next of outgoing.get(fromId) ?? []) {
    if (next === toId) continue;
    if (!seen.has(next)) {
      seen.add(next);
      queue.push(next);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of outgoing.get(current) ?? []) {
      if (next === toId) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

function wouldBeShortcut(
  edges: ChipEdge[],
  fromId: string,
  toId: string,
  kind: ChipEdgeKind,
  toKind: ChipKind,
) {
  if (kind === "on_error") return false;
  if (!indirectPathExists(edges, fromId, toId)) return false;
  if (kind === "data" && toKind === "validation") return false;
  if (kind !== "data" && hasDataEdge(edges, fromId, toId)) return false;
  return true;
}

export function edgeConnectIssue(
  from: Chip,
  to: Chip,
  kind: ChipEdgeKind,
  edges: ChipEdge[],
): EdgeConnectIssue | null {
  if (from.id === to.id) return "self";
  if (kind === "data" ? !canHaveDataEdge(from.kind, to.kind) : !canHaveControlEdge(from.kind, to.kind)) {
    return "kind";
  }
  if (sameKindPairEdges(edges, from.id, to.id, kind).length > 0) return "duplicate";
  if (graphHasCycle(edges) || pathExists(edges, to.id, from.id, ALL_KINDS)) {
    return "cycle";
  }
  if (kind === "on_error" && dataDependsOn(edges, to.id, from.id)) return "error-data";
  if (wouldBeShortcut(edges, from.id, to.id, kind, to.kind)) return "shortcut";
  if (kind === "data" && to.kind !== "validation") {
    const incoming = edges.filter((edge) => edge.kind === "data" && edge.to_chip_id === to.id);
    if (incoming.length > 0) return "inputs";
  }
  if (kind === "data" && to.kind === "validation") {
    const incoming = edges.filter((edge) => edge.kind === "data" && edge.to_chip_id === to.id);
    if (incoming.some((edge) => edge.from_chip_id === from.id)) return "duplicate";
    if (incoming.length >= 2) return "inputs";
  }
  return null;
}

export function canvasEdgesIssue(chips: Chip[], edges: ChipEdge[]): EdgeConnectIssue | null {
  if (graphHasCycle(edges)) return "cycle";
  const byId = new Map(chips.map((chip) => [chip.id, chip]));
  const incoming = new Map<string, ChipEdge[]>();
  for (const edge of edges) {
    if (edge.kind !== "data") continue;
    const list = incoming.get(edge.to_chip_id) ?? [];
    list.push(edge);
    incoming.set(edge.to_chip_id, list);
  }
  for (const chip of chips) {
    const data = incoming.get(chip.id) ?? [];
    if (chip.kind === "validation") {
      if (data.length > 2) return "inputs";
      const fromIds = data.map((edge) => edge.from_chip_id);
      if (new Set(fromIds).size !== fromIds.length) return "duplicate";
    } else if (data.length > 1) {
      return "inputs";
    }
  }
  for (const edge of edges) {
    const from = byId.get(edge.from_chip_id);
    const to = byId.get(edge.to_chip_id);
    if (!from || !to) continue;
    const rest = edges.filter((item) => item.id !== edge.id);
    const issue = edgeConnectIssue(from, to, edge.kind, rest);
    if (issue) return issue;
  }
  return null;
}

export function visibleCanvasEdges(edges: ChipEdge[]): ChipEdge[] {
  return edges.filter((edge) => edge.kind !== "data");
}

/** Same pair + same slot. Success, failure, and always share one control slot. */
export function sameKindPairEdges(
  edges: ChipEdge[],
  fromId: string,
  toId: string,
  kind: ChipEdgeKind,
): ChipEdge[] {
  const control = kind === "on_success" || kind === "on_error" || kind === "always";
  return edges.filter((edge) => {
    if (edge.from_chip_id !== fromId || edge.to_chip_id !== toId) return false;
    if (edge.kind === kind) return true;
    return control && (edge.kind === "on_success" || edge.kind === "on_error" || edge.kind === "always");
  });
}

export function producerChips(chips: Chip[], excludeIds: Iterable<string> = []): Chip[] {
  const skip = new Set(excludeIds);
  return chips.filter((chip) =>
    (chip.kind === "extract" || chip.kind === "transform" || chip.kind === "script") && !skip.has(chip.id),
  );
}

export function validationTargetChips(chips: Chip[], excludeIds: Iterable<string> = []): Chip[] {
  const skip = new Set(excludeIds);
  return chips.filter((chip) =>
    (chip.kind === "extract" || chip.kind === "transform" || chip.kind === "load" || chip.kind === "script") && !skip.has(chip.id),
  );
}

export function incomingDataChipId(edges: ChipEdge[], toId: string, toPort?: string): string {
  const incoming = edges.filter((edge) => edge.kind === "data" && edge.to_chip_id === toId);
  if (toPort) return incoming.find((edge) => edge.to_port === toPort)?.from_chip_id ?? "";
  return incoming[0]?.from_chip_id ?? "";
}

function stripShortcutControlEdges(edges: ChipEdge[]): ChipEdge[] {
  return edges.filter((edge) => {
    if (edge.kind !== "on_success" && edge.kind !== "always") return true;
    const rest = edges.filter((item) => item.id !== edge.id);
    return !wouldBeShortcut(rest, edge.from_chip_id, edge.to_chip_id, edge.kind, "sql");
  });
}

export function withCompanionSuccessEdges(
  edges: ChipEdge[],
  positions: Record<string, Point>,
  workspaceId: string,
): ChipEdge[] {
  const controlPairs = new Set(
    edges
      .filter((edge) => edge.kind === "on_success" || edge.kind === "on_error" || edge.kind === "always")
      .map((edge) => pairKey(edge.from_chip_id, edge.to_chip_id)),
  );
  const added: ChipEdge[] = [];
  for (const edge of edges) {
    if (edge.kind !== "data") continue;
    const key = pairKey(edge.from_chip_id, edge.to_chip_id);
    if (controlPairs.has(key)) continue;
    controlPairs.add(key);
    const fromPoint = positions[edge.from_chip_id] ?? fallbackPoint(0);
    const toPoint = positions[edge.to_chip_id] ?? fallbackPoint(0);
    const route = routeSides(fromPoint, toPoint);
    added.push({
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      from_chip_id: edge.from_chip_id,
      to_chip_id: edge.to_chip_id,
      kind: "on_success",
      from_port: route.fromSide,
      to_port: route.toSide,
    });
  }
  return added.length === 0 ? edges : [...edges, ...added];
}

export function attachHiddenDataEdges(
  current: ChipEdge[],
  inputs: { fromId: string; toId: string; toPort?: string }[],
  positions: Record<string, Point>,
  workspaceId: string,
): ChipEdge[] {
  const dropExact = new Set(
    inputs
      .filter((input) => input.toPort)
      .map((input) => `${input.toId}\0${input.toPort}`),
  );
  const dropAll = new Set(inputs.filter((input) => !input.toPort).map((input) => input.toId));
  const droppedData = current.filter((edge) => {
    if (edge.kind !== "data") return false;
    if (dropAll.has(edge.to_chip_id)) return true;
    return dropExact.has(`${edge.to_chip_id}\0${edge.to_port}`);
  });
  const droppedPairs = new Set(
    droppedData.map((edge) => pairKey(edge.from_chip_id, edge.to_chip_id)),
  );
  const kept = current.filter((edge) => {
    if (droppedData.some((item) => item.id === edge.id)) return false;
    if (edge.kind === "on_success" && droppedPairs.has(pairKey(edge.from_chip_id, edge.to_chip_id))) {
      return false;
    }
    return true;
  });
  const added = inputs
    .filter((input) => input.fromId)
    .map((input) => {
      const fromPoint = positions[input.fromId] ?? fallbackPoint(0);
      const toPoint = positions[input.toId] ?? fallbackPoint(0);
      const route = routeSides(fromPoint, toPoint);
      return {
        id: crypto.randomUUID(),
        workspace_id: workspaceId,
        from_chip_id: input.fromId,
        to_chip_id: input.toId,
        kind: "data" as const,
        from_port: route.fromSide,
        to_port: input.toPort ?? route.toSide,
      };
    });
  return withCompanionSuccessEdges(
    stripShortcutControlEdges([...kept, ...added]),
    positions,
    workspaceId,
  );
}

export function storedDatasetId(id: string | undefined | null): string {
  const value = id?.trim() ?? "";
  // Contract ids are graph-derived placeholders, not user-selected fixed inputs.
  return !value || value.startsWith("contract:") ? "" : value;
}

export function chipFixedInputId(chip: Chip): string {
  const value = chip.config.input_dataset_id;
  return typeof value === "string" ? storedDatasetId(value) : "";
}

if (import.meta.env.DEV) {
  console.assert(storedDatasetId("contract:ws:chip") === "", "canvas: drop planned input ids");
  console.assert(storedDatasetId("11111111-1111-1111-1111-111111111111") === "11111111-1111-1111-1111-111111111111", "canvas: keep real dataset ids");
  const sample: ChipEdge = {
    id: "e1",
    workspace_id: "ws",
    from_chip_id: "a",
    to_chip_id: "b",
    kind: "data",
    from_port: "right",
    to_port: "left",
  };
  const control: ChipEdge = { ...sample, id: "e2", kind: "on_success" };
  console.assert(visibleCanvasEdges([sample, control]).map((edge) => edge.id).join(",") === "e2", "canvas: hide data wires");
  console.assert(
    sameKindPairEdges([sample, control], "a", "b", "on_success").map((edge) => edge.id).join(",") === "e2",
    "canvas: control connect ignores hidden data",
  );
  const failure: ChipEdge = { ...control, id: "e3", kind: "on_error" };
  console.assert(
    sameKindPairEdges([control, failure], "a", "b", "always").map((edge) => edge.id).sort().join(",") === "e2,e3",
    "canvas: one control slot per pair",
  );
  const replaced = attachHiddenDataEdges(
    [sample, control],
    [{ fromId: "c", toId: "b" }],
    { a: { x: 0, y: 0 }, b: { x: 200, y: 0 }, c: { x: 0, y: 80 } },
    "ws",
  );
  console.assert(
    replaced.some((edge) => edge.kind === "data" && edge.from_chip_id === "c" && edge.to_chip_id === "b")
    && replaced.some((edge) => edge.kind === "on_success" && edge.from_chip_id === "c" && edge.to_chip_id === "b")
    && !replaced.some((edge) => edge.id === "e1")
    && !replaced.some((edge) => edge.id === "e2"),
    "canvas: replace hidden data input",
  );
  console.assert(canHaveDataEdge("load", "validation"), "canvas: load may feed validation");
  console.assert(!canHaveDataEdge("load", "transform"), "canvas: load may not feed transform");
  console.assert(!canHaveDataEdge("load", "load"), "canvas: load may not feed load");
  console.assert(canHaveControlEdge("extract", "load"), "canvas: extract may sequence load");
  console.assert(!canHaveControlEdge("load", "extract"), "canvas: load may not sequence extract");
  console.assert(!canHaveControlEdge("validation", "load"), "canvas: validation is a sink");
  console.assert(canHaveControlEdge("sql", "extract"), "canvas: sql may sequence extract");
  console.assert(canHaveDataEdge("script", "transform"), "canvas: script may feed transform");
  console.assert(canHaveDataEdge("extract", "script"), "canvas: extract may feed script");
  console.assert(canHaveDataEdge("script", "script"), "canvas: script may feed script");
  const chip = (id: string, kind: ChipKind): Chip => ({
    id, owner_user_id: "", name: id, kind, config: {}, revision: 0, active: true, created_at: "", updated_at: "",
  });
  const wire = (
    id: string,
    from: string,
    to: string,
    kind: ChipEdgeKind,
    port = "left",
  ): ChipEdge => ({
    id, workspace_id: "ws", from_chip_id: from, to_chip_id: to, kind, from_port: "right", to_port: port,
  });
  const extract = chip("extract", "extract");
  const transform = chip("transform", "transform");
  const load = chip("load", "load");
  const validation = chip("validation", "validation");
  const pipeline = [
    wire("d1", "extract", "transform", "data"),
    wire("s1", "extract", "transform", "on_success"),
    wire("d2", "transform", "load", "data"),
    wire("s2", "transform", "load", "on_success"),
  ];
  console.assert(
    edgeConnectIssue(extract, load, "on_success", pipeline) === "shortcut",
    "canvas: block extract→load shortcut",
  );
  console.assert(
    edgeConnectIssue(extract, load, "data", pipeline.filter((edge) => edge.to_chip_id !== "load")) === null,
    "canvas: rewiring load to extract is not a shortcut",
  );
  const validationGraph = [
    ...pipeline,
    wire("d3", "extract", "validation", "data", "source"),
    wire("s3", "extract", "validation", "on_success"),
    wire("d4", "transform", "validation", "data", "target"),
    wire("s4", "transform", "validation", "on_success"),
  ];
  console.assert(
    edgeConnectIssue(extract, validation, "on_success", validationGraph) === "duplicate",
    "canvas: validation source already wired",
  );
  console.assert(
    canvasEdgesIssue([extract, transform, load, validation], validationGraph) === null,
    "canvas: extract+transform validation pair is allowed",
  );
  console.assert(
    edgeConnectIssue(extract, load, "on_error", pipeline) === "error-data",
    "canvas: on_error into data consumer",
  );
  console.assert(
    edgeConnectIssue(load, extract, "on_success", []) === "kind",
    "canvas: reverse control kind",
  );
  console.assert(
    edgeConnectIssue(extract, transform, "on_success", [wire("back", "transform", "extract", "always")]) === "cycle",
    "canvas: connect-time cycle",
  );
  const empty = { chips: [], positions: {}, edges: [] } satisfies CanvasSnapshot;
  const moved = { chips: [], positions: { a: { x: 1, y: 2 } }, edges: [] } satisfies CanvasSnapshot;
  console.assert(appendCanvasUndo([], empty).length === 1, "undo: push first snapshot");
  console.assert(appendCanvasUndo([empty], empty).length === 1, "undo: skip duplicate snapshot");
  console.assert(appendCanvasUndo([empty], moved).length === 2, "undo: keep distinct snapshot");
}
