import { layout } from "@/lib/layout";
import type { WidgetId, WidgetLayout } from "./types";

const COLS = layout.dashboard.cols;
const STORAGE_KEY = "bintl.dashboard-layout.v3";

export const DEFAULT_LAYOUT: WidgetLayout[] = [
  { id: "summary", x: 0, y: 0, w: 8, h: 4, visible: true },
  { id: "assets", x: 8, y: 0, w: 4, h: 6, visible: true },
  { id: "trend", x: 0, y: 4, w: 8, h: 6, visible: true },
  { id: "funnel", x: 8, y: 6, w: 4, h: 5, visible: true },
  { id: "attention", x: 0, y: 10, w: 8, h: 6, visible: true },
  { id: "start", x: 8, y: 11, w: 4, h: 6, visible: true },
  { id: "activity", x: 0, y: 17, w: 12, h: 4, visible: true },
];

export const WIDGET_BOUNDS: Record<WidgetId, { minW: number; minH: number }> = {
  summary: { minW: 5, minH: 3 },
  assets: { minW: 3, minH: 5 },
  trend: { minW: 5, minH: 4 },
  funnel: { minW: 3, minH: 4 },
  attention: { minW: 4, minH: 4 },
  start: { minW: 3, minH: 5 },
  activity: { minW: 6, minH: 3 },
};

export function cloneDefaultLayout(): WidgetLayout[] {
  return DEFAULT_LAYOUT.map((item) => ({ ...item }));
}

export function collides(a: WidgetLayout, b: WidgetLayout) {
  return (
    a.id !== b.id &&
    a.visible &&
    b.visible &&
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

export function clampItem(item: WidgetLayout): WidgetLayout {
  const bounds = WIDGET_BOUNDS[item.id];
  const w = Math.max(bounds.minW, Math.min(COLS, Math.round(item.w)));
  const h = Math.max(bounds.minH, Math.round(item.h));
  const x = Math.max(0, Math.min(COLS - w, Math.round(item.x)));
  const y = Math.max(0, Math.round(item.y));
  return { ...item, x, y, w, h };
}

export function sortLayout(items: WidgetLayout[]) {
  return [...items].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
}

function placeAvoiding(blockers: WidgetLayout[], item: WidgetLayout) {
  const next = clampItem({ ...item });
  for (let guard = 0; guard < 240; guard += 1) {
    const hit = blockers.find((blocker) => collides(next, blocker));
    if (!hit) break;
    next.y = hit.y + hit.h;
  }
  return next;
}

export function compact(items: WidgetLayout[]): WidgetLayout[] {
  const hidden = items.filter((item) => !item.visible);
  const placed: WidgetLayout[] = [];
  for (const item of sortLayout(items.filter((row) => row.visible))) {
    placed.push(placeAvoiding(placed, { ...item, y: 0 }));
  }
  return [...placed, ...hidden];
}

export function resolveCollisions(items: WidgetLayout[], movingId: WidgetId): WidgetLayout[] {
  const moving = items.find((item) => item.id === movingId);
  if (!moving || !moving.visible) return items;
  const hidden = items.filter((item) => !item.visible);
  const rest = sortLayout(items.filter((item) => item.visible && item.id !== movingId));
  const placed: WidgetLayout[] = [clampItem(moving)];
  for (const item of rest) {
    placed.push(placeAvoiding(placed, item));
  }
  return [...placed, ...hidden];
}

export function moveItem(items: WidgetLayout[], id: WidgetId, x: number, y: number) {
  return resolveCollisions(
    items.map((item) => (item.id === id ? { ...item, x, y } : item)),
    id,
  );
}

export function resizeItem(items: WidgetLayout[], id: WidgetId, w: number, h: number) {
  return resolveCollisions(
    items.map((item) => (item.id === id ? { ...item, w, h } : item)),
    id,
  );
}

export function resetWidgetSize(items: WidgetLayout[], id: WidgetId) {
  const def = DEFAULT_LAYOUT.find((item) => item.id === id);
  if (!def) return items;
  return resizeItem(items, id, def.w, def.h);
}

export function hideWidget(items: WidgetLayout[], id: WidgetId) {
  return compact(items.map((item) => (item.id === id ? { ...item, visible: false } : item)));
}

export function showWidget(items: WidgetLayout[], id: WidgetId) {
  const current = items.find((item) => item.id === id);
  if (!current || current.visible) return items;
  const others = items.filter((item) => item.visible);
  const y = others.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  const placed = clampItem({ ...current, visible: true, x: 0, y });
  return items.map((item) => (item.id === id ? placed : item));
}

export function colWidth(boardWidth: number) {
  const { cols, gap } = layout.dashboard;
  return Math.max(1, (boardWidth - gap * (cols - 1)) / cols);
}

export function rectFor(item: WidgetLayout, columnWidth: number) {
  const { rowHeight, gap } = layout.dashboard;
  return {
    left: item.x * (columnWidth + gap),
    top: item.y * (rowHeight + gap),
    width: item.w * columnWidth + (item.w - 1) * gap,
    height: item.h * rowHeight + (item.h - 1) * gap,
  };
}

export function snapPoint(left: number, top: number, columnWidth: number) {
  const { rowHeight, gap } = layout.dashboard;
  return {
    x: Math.round(left / (columnWidth + gap)),
    y: Math.round(top / (rowHeight + gap)),
  };
}

export function snapSize(width: number, height: number, columnWidth: number) {
  const { rowHeight, gap } = layout.dashboard;
  return {
    w: Math.max(1, Math.round((width + gap) / (columnWidth + gap))),
    h: Math.max(1, Math.round((height + gap) / (rowHeight + gap))),
  };
}

export function clampPixelSize(
  id: WidgetId,
  x: number,
  width: number,
  height: number,
  columnWidth: number,
) {
  const bounds = WIDGET_BOUNDS[id];
  const maxW = layout.dashboard.cols - x;
  const min = rectFor(
    { id, x: 0, y: 0, w: bounds.minW, h: bounds.minH, visible: true },
    columnWidth,
  );
  const max = rectFor(
    { id, x: 0, y: 0, w: maxW, h: bounds.minH, visible: true },
    columnWidth,
  );
  return {
    width: Math.min(max.width, Math.max(min.width, width)),
    height: Math.max(min.height, height),
  };
}

export function boardHeight(items: WidgetLayout[]) {
  const { rowHeight, gap } = layout.dashboard;
  const visible = items.filter((item) => item.visible);
  if (!visible.length) return rowHeight * 3;
  const rows = Math.max(...visible.map((item) => item.y + item.h));
  return rows * rowHeight + Math.max(0, rows - 1) * gap;
}

export function stackLayouts(items: WidgetLayout[]) {
  let y = 0;
  return sortLayout(items.filter((item) => item.visible)).map((item) => {
    const next = clampItem({ ...item, x: 0, w: COLS, y });
    y += next.h;
    return next;
  });
}

function asNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function loadSessionLayouts(): WidgetLayout[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefaultLayout();
    const parsed = JSON.parse(raw) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return cloneDefaultLayout();
    const byId = new Map<string, Record<string, unknown>>();
    for (const row of parsed.items) {
      if (row && typeof row === "object" && "id" in row && typeof row.id === "string") {
        byId.set(row.id, row as Record<string, unknown>);
      }
    }
    return DEFAULT_LAYOUT.map((def) => {
      const saved = byId.get(def.id);
      if (!saved) return { ...def };
      return clampItem({
        id: def.id,
        x: asNumber(saved.x, def.x),
        y: asNumber(saved.y, def.y),
        w: asNumber(saved.w, def.w),
        h: asNumber(saved.h, def.h),
        visible: typeof saved.visible === "boolean" ? saved.visible : def.visible,
      });
    });
  } catch {
    return cloneDefaultLayout();
  }
}

export function saveSessionLayouts(items: WidgetLayout[]) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ items }));
  } catch {
    /* ignore quota / private mode */
  }
}

export function wipeLegacyLayouts() {
  try {
    localStorage.removeItem("bintl.dashboard-layout");
    localStorage.removeItem("bintl.dashboard-layout.v2");
    localStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem("bintl.dashboard-layout");
    sessionStorage.removeItem("bintl.dashboard-layout.v2");
  } catch {
    /* ignore quota / private mode */
  }
}

export function clearStoredLayouts() {
  wipeLegacyLayouts();
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore quota / private mode */
  }
}

if (import.meta.env.DEV) {
  const a: WidgetLayout = { id: "summary", x: 0, y: 0, w: 8, h: 4, visible: true };
  const b: WidgetLayout = { id: "assets", x: 8, y: 0, w: 4, h: 4, visible: true };
  console.assert(!collides(a, b), "dashboard: side-by-side tiles do not collide");
  console.assert(collides(a, { ...b, x: 6 }), "dashboard: overlap collides");
  const moved = moveItem([a, b], "summary", 4, 0);
  const assets = moved.find((item) => item.id === "assets");
  console.assert((assets?.y ?? 0) >= 4, "dashboard: overlap pushes the other tile down");
  const hidden = hideWidget([a, b], "summary");
  const remaining = hidden.find((item) => item.id === "assets");
  console.assert(remaining?.y === 0, "dashboard: close compacts remaining tiles");
  const restored = showWidget(hidden, "summary");
  console.assert(restored.find((item) => item.id === "summary")?.visible, "dashboard: restore shows tile");
}
