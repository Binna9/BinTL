import {
  Children,
  Fragment,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/cn";
import { layout } from "@/lib/layout";

export function SplitLayout({
  direction = "horizontal",
  defaultSizes,
  minSize,
  maxSize,
  fill = true,
  className,
  children,
}: {
  direction?: "horizontal" | "vertical";
  defaultSizes: number[];
  minSize?: number;
  maxSize?: number;
  fill?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const panes = Children.toArray(children).filter(Boolean);
  const isRow = direction === "horizontal";
  const floor = minSize ?? (isRow ? layout.split.minPane : layout.split.minStack);
  const [sizes, setSizes] = useState(defaultSizes);
  const drag = useRef<{ index: number; start: number; size: number } | null>(null);

  useEffect(() => {
    function onMove(event: MouseEvent) {
      const active = drag.current;
      if (!active) return;
      const pos = isRow ? event.clientX : event.clientY;
      setSizes((prev) => {
        const next = [...prev];
        const raw = active.size + (pos - active.start);
        next[active.index] = Math.max(floor, maxSize ? Math.min(maxSize, raw) : raw);
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
  }, [floor, isRow, maxSize]);

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
      className={cn(
        "flex",
        fill && "min-h-0 min-w-0 overflow-hidden",
        isRow ? "flex-row" : "flex-col",
        className,
      )}
    >
      {panes.map((pane, index) => {
        const last = index === panes.length - 1;
        return (
          <Fragment key={index}>
            {index > 0 ? (
              <button
                type="button"
                aria-label="영역 크기 조절"
                aria-orientation={isRow ? "vertical" : "horizontal"}
                className={cn(
                  "relative z-10 shrink-0 border-0 bg-border p-0 hover:bg-accent",
                  isRow
                    ? "w-px cursor-col-resize after:absolute after:inset-y-0 after:-left-1 after:w-2.5 after:content-['']"
                    : "h-px cursor-row-resize after:absolute after:inset-x-0 after:-top-1 after:h-2.5 after:content-['']",
                )}
                onMouseDown={(event) => onGutterDown(index - 1, event)}
              />
            ) : null}
            <div
              className={cn(
                "flex flex-col",
                fill && "min-h-0 min-w-0 overflow-hidden",
                last ? "min-w-0 flex-1" : "shrink-0",
              )}
              style={
                last
                  ? undefined
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
