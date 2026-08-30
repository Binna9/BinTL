import {
  Children,
  CSSProperties,
  Fragment,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/cn";
import { useLanguage } from "@/i18n/LanguageProvider";
import { layout } from "@/lib/layout";

export function SplitLayout({
  direction = "horizontal",
  reverse = false,
  defaultSizes,
  defaultRatio,
  minSize,
  maxSize,
  fill = true,
  className,
  style,
  children,
}: {
  direction?: "horizontal" | "vertical";
  reverse?: boolean;
  defaultSizes: number[];
  /** When set, first pane starts at this fraction of the host (e.g. 0.5 = half). */
  defaultRatio?: number;
  minSize?: number;
  maxSize?: number;
  fill?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const { messages } = useLanguage();
  const panes = Children.toArray(children).filter(Boolean);
  const isRow = direction === "horizontal";
  const floor = minSize ?? (isRow ? layout.split.minPane : layout.split.minStack);
  const [sizes, setSizes] = useState(defaultSizes);
  const hostRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ index: number; start: number; size: number } | null>(null);
  const ratioApplied = useRef(false);

  useLayoutEffect(() => {
    if (defaultRatio == null || ratioApplied.current) return;
    const ratio = defaultRatio;
    const host = hostRef.current;
    if (!host) return;

    function apply() {
      if (ratioApplied.current || !host) return;
      const hostSize = isRow ? host.clientWidth : host.clientHeight;
      if (hostSize <= 0) return;
      const available = hostSize - floor - (panes.length - 1);
      const ceiling = Math.max(floor, Math.min(maxSize ?? Number.POSITIVE_INFINITY, available));
      const next = Math.min(ceiling, Math.max(floor, Math.round(hostSize * ratio)));
      ratioApplied.current = true;
      setSizes([next]);
    }

    apply();
    if (ratioApplied.current) return;
    const observer = new ResizeObserver(() => apply());
    observer.observe(host);
    return () => observer.disconnect();
  }, [defaultRatio, floor, isRow, maxSize, panes.length]);

  useEffect(() => {
    function onMove(event: MouseEvent) {
      const active = drag.current;
      if (!active) return;
      const pos = isRow ? event.clientX : event.clientY;
      setSizes((prev) => {
        const next = [...prev];
        const delta = reverse ? active.start - pos : pos - active.start;
        const raw = active.size + delta;
        const hostSize = isRow
          ? hostRef.current?.clientWidth
          : hostRef.current?.clientHeight;
        const available = hostSize
          ? hostSize - floor - (panes.length - 1)
          : Number.POSITIVE_INFINITY;
        const ceiling = Math.max(floor, Math.min(maxSize ?? Number.POSITIVE_INFINITY, available));
        next[active.index] = Math.min(ceiling, Math.max(floor, raw));
        return next;
      });
    }

    function onUp() {
      if (!drag.current) return;
      drag.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [floor, isRow, maxSize, panes.length, reverse]);

  function onGutterDown(index: number, event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    drag.current = {
      index,
      start: isRow ? event.clientX : event.clientY,
      size: sizes[index] ?? defaultSizes[index] ?? floor,
    };
    document.body.style.cursor = isRow ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  }

  return (
    <div
      ref={hostRef}
      className={cn(
        "flex",
        fill && "min-h-0 min-w-0 overflow-hidden",
        isRow ? (reverse ? "flex-row-reverse" : "flex-row") : reverse ? "flex-col-reverse" : "flex-col",
        className,
      )}
      style={style}
    >
      {panes.map((pane, index) => {
        const last = index === panes.length - 1;
        return (
          <Fragment key={index}>
            {index > 0 ? (
              <button
                type="button"
                aria-label={messages.common.resizePane}
                aria-orientation={isRow ? "vertical" : "horizontal"}
                className={cn(
                  "group relative z-10 shrink-0 border-0 bg-border/70 p-0 outline-none transition-colors duration-200 hover:bg-border-strong focus-visible:bg-border-strong",
                  isRow
                    ? "w-px cursor-col-resize after:absolute after:inset-y-0 after:-left-1 after:w-2.5 after:content-['']"
                    : "h-px cursor-row-resize after:absolute after:inset-x-0 after:-top-1 after:h-2.5 after:content-['']",
                )}
                onMouseDown={(event) => onGutterDown(index - 1, event)}
              >
                <span
                  className={cn(
                    "pointer-events-none absolute left-1/2 top-1/2 rounded-full bg-text-tertiary/50 opacity-0 shadow-sm transition-[opacity,background-color,transform] duration-200 group-hover:opacity-100 group-focus-visible:opacity-100 group-active:bg-text-secondary group-active:opacity-100",
                    isRow
                      ? "h-10 w-1 -translate-x-1/2 -translate-y-1/2 group-hover:scale-y-110"
                      : "h-1 w-10 -translate-x-1/2 -translate-y-1/2 group-hover:scale-x-110",
                  )}
                />
              </button>
            ) : null}
            <div
              className={cn(
                "flex flex-col",
                fill && "min-h-0 min-w-0 overflow-hidden",
                last ? "min-w-0 flex-1" : "shrink-0",
              )}
              style={
                last
                  ? isRow
                    ? { minWidth: floor }
                    : { minHeight: floor }
                  : isRow
                    ? { width: sizes[index] ?? defaultSizes[index] }
                    : { height: sizes[index] ?? defaultSizes[index] }
              }
            >
              {pane}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
