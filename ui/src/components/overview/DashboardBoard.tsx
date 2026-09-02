import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { layout } from "@/lib/layout";
import { useLanguage } from "@/i18n/LanguageProvider";
import { useDashboard } from "@/hooks/overview/DashboardContext";
import { DashboardWidget } from "./DashboardWidget";
import {
  boardHeight,
  clampItem,
  clampPixelSize,
  colWidth,
  rectFor,
  snapPoint,
  snapSize,
  stackLayouts,
} from "./layout";
import type { WidgetId, WidgetLayout } from "./types";

type DragSession = {
  id: WidgetId;
  startX: number;
  startY: number;
  left: number;
  top: number;
  width: number;
  height: number;
  snapX: number;
  snapY: number;
};

type ResizeSession = {
  id: WidgetId;
  x: number;
  left: number;
  top: number;
  startX: number;
  startY: number;
  originW: number;
  originH: number;
  width: number;
  height: number;
  snapW: number;
  snapH: number;
};

function displayItems(items: WidgetLayout[], stacked: boolean) {
  return stacked ? stackLayouts(items) : items.filter((item) => item.visible);
}

export function DashboardBoard() {
  const { messages } = useLanguage();
  const { items, move, resize } = useDashboard();
  const boardRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragSession | null>(null);
  const sizing = useRef<ResizeSession | null>(null);
  const moveRef = useRef(move);
  const resizeRef = useRef(resize);
  const [width, setWidth] = useState(0);
  const [float, setFloat] = useState<DragSession | null>(null);
  const [sizePreview, setSizePreview] = useState<ResizeSession | null>(null);
  moveRef.current = move;
  resizeRef.current = resize;

  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    function end() {
      const dragging = drag.current;
      const resizing = sizing.current;
      drag.current = null;
      sizing.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      if (dragging) {
        moveRef.current(dragging.id, dragging.snapX, dragging.snapY);
      }
      if (resizing) {
        resizeRef.current(resizing.id, resizing.snapW, resizing.snapH);
      }
      setFloat(null);
      setSizePreview(null);
    }

    function onMove(event: PointerEvent) {
      const board = boardRef.current;
      if (!board) return;
      const column = colWidth(board.clientWidth);
      const dragging = drag.current;
      if (dragging) {
        const left = Math.min(
          Math.max(0, dragging.left + event.clientX - dragging.startX),
          Math.max(0, board.clientWidth - dragging.width),
        );
        const top = Math.max(0, dragging.top + event.clientY - dragging.startY);
        const snap = snapPoint(left, top, column);
        dragging.snapX = snap.x;
        dragging.snapY = snap.y;
        setFloat({ ...dragging, left, top });
        return;
      }
      const resizing = sizing.current;
      if (!resizing) return;
      const clamped = clampPixelSize(
        resizing.id,
        resizing.x,
        resizing.originW + event.clientX - resizing.startX,
        resizing.originH + event.clientY - resizing.startY,
        column,
      );
      const snap = snapSize(clamped.width, clamped.height, column);
      resizing.width = clamped.width;
      resizing.height = clamped.height;
      resizing.snapW = snap.w;
      resizing.snapH = snap.h;
      setSizePreview({ ...resizing });
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, []);

  const stacked = width > 0 && width < layout.dashboard.stackAt;
  const interactive = !stacked;
  const column = width ? colWidth(width) : 0;
  const tiles = displayItems(items, stacked);
  const placeholder = float
    ? clampItem({
        id: float.id,
        x: float.snapX,
        y: float.snapY,
        w: items.find((item) => item.id === float.id)?.w ?? 1,
        h: items.find((item) => item.id === float.id)?.h ?? 1,
        visible: true,
      })
    : null;
  const placeholderRect = placeholder && column ? rectFor(placeholder, column) : null;
  const height = Math.max(
    boardHeight(tiles),
    placeholderRect ? placeholderRect.top + placeholderRect.height : 0,
    float ? float.top + float.height : 0,
    sizePreview ? sizePreview.top + sizePreview.height : 0,
  );

  function onMoveStart(event: ReactPointerEvent<HTMLElement>, id: WidgetId) {
    if (!interactive || !column || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const item = tiles.find((tile) => tile.id === id);
    if (!item) return;
    const rect = rectFor(item, column);
    const session: DragSession = {
      id,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      snapX: item.x,
      snapY: item.y,
    };
    drag.current = session;
    setFloat(session);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";
  }

  function onResizeStart(event: ReactPointerEvent<HTMLButtonElement>, id: WidgetId) {
    if (!interactive || !column || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const item = tiles.find((tile) => tile.id === id);
    if (!item) return;
    const rect = rectFor(item, column);
    event.currentTarget.setPointerCapture(event.pointerId);
    const session: ResizeSession = {
      id,
      x: item.x,
      left: rect.left,
      top: rect.top,
      startX: event.clientX,
      startY: event.clientY,
      originW: rect.width,
      originH: rect.height,
      width: rect.width,
      height: rect.height,
      snapW: item.w,
      snapH: item.h,
    };
    sizing.current = session;
    setSizePreview(session);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "se-resize";
  }

  const empty = tiles.length === 0;

  return (
    <div
      ref={boardRef}
      className={empty ? "relative grid h-full min-h-0 flex-1 place-items-center" : "relative"}
      style={empty ? undefined : { minHeight: height }}
      aria-label={messages.overview.title}
    >
      {empty ? (
        <p className="max-w-md px-6 text-center text-sm text-text-secondary">
          {messages.overview.emptyBoard}
        </p>
      ) : null}
      {placeholderRect ? (
        <div
          className="pointer-events-none absolute rounded-xl border-2 border-dashed border-accent/50 bg-accent/10"
          style={placeholderRect}
        />
      ) : null}
      {column
        ? tiles.map((item) => {
            const rect = rectFor(item, column);
            const floating = float?.id === item.id;
            const resizing = sizePreview?.id === item.id;
            return (
              <DashboardWidget
                key={item.id}
                id={item.id}
                interactive={interactive}
                floating={floating || resizing}
                style={
                  floating && float
                    ? {
                        left: float.left,
                        top: float.top,
                        width: float.width,
                        height: float.height,
                      }
                    : resizing && sizePreview
                      ? {
                          left: sizePreview.left,
                          top: sizePreview.top,
                          width: sizePreview.width,
                          height: sizePreview.height,
                        }
                      : rect
                }
                onMoveStart={onMoveStart}
                onResizeStart={onResizeStart}
              />
            );
          })
        : null}
    </div>
  );
}
