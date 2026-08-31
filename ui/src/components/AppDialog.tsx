import {
  PointerEvent as ReactPointerEvent,
  ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { X } from "lucide-react";
import { ResizeGrip } from "@/components/ui/resize-grip";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";

const closeStack: Array<() => void> = [];

export function AppDialog({
  open,
  title,
  icon,
  headerExtra,
  footer,
  children,
  className,
  overlayClassName,
  zIndex = 100,
  minWidth = 360,
  minHeight = 240,
  defaultOffset = { x: 0, y: 0 },
  labelledBy,
  hideHeaderClose = false,
  onClose,
}: {
  open: boolean;
  title: ReactNode;
  icon?: ReactNode;
  headerExtra?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  overlayClassName?: string;
  zIndex?: number;
  minWidth?: number;
  minHeight?: number;
  defaultOffset?: { x: number; y: number };
  labelledBy?: string;
  hideHeaderClose?: boolean;
  onClose: () => void;
}) {
  const { messages } = useLanguage();
  const titleId = useId();
  const boxRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const resize = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const [offset, setOffset] = useState(defaultOffset);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    setOffset(defaultOffset);
    setSize(null);
  }, [open, defaultOffset.x, defaultOffset.y]);

  useEffect(() => {
    if (!open) return;
    const close = () => onCloseRef.current();
    closeStack.push(close);
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (closeStack[closeStack.length - 1] !== close) return;
      event.preventDefault();
      close();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      const at = closeStack.lastIndexOf(close);
      if (at >= 0) closeStack.splice(at, 1);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function end() {
      drag.current = null;
      resize.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    }

    function onPointerMove(event: PointerEvent) {
      if (event.buttons === 0 && (drag.current || resize.current)) {
        end();
        return;
      }
      const moving = drag.current;
      if (moving) {
        setOffset({
          x: moving.left + event.clientX - moving.x,
          y: moving.top + event.clientY - moving.y,
        });
        return;
      }
      const sizing = resize.current;
      if (!sizing) return;
      setSize({
        w: Math.max(minWidth, sizing.w + event.clientX - sizing.x),
        h: Math.max(minHeight, sizing.h + event.clientY - sizing.y),
      });
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [open, minWidth, minHeight]);

  function onHeaderDown(event: ReactPointerEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("button")) return;
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      left: offset.x,
      top: offset.y,
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "move";
  }

  function onResizeDown(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    const box = boxRef.current;
    if (!box) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resize.current = {
      x: event.clientX,
      y: event.clientY,
      w: box.offsetWidth,
      h: box.offsetHeight,
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "se-resize";
  }

  if (!open) return null;

  return (
    <div
      className={cn(
        "fixed inset-0 grid place-items-center bg-workspace/60 p-3 backdrop-blur-[1px]",
        overlayClassName,
      )}
      style={{ zIndex }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? titleId}
        className={cn(
          "relative flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xl",
          className,
        )}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px)`,
          ...(size ? { width: size.w, height: size.h, maxWidth: "none", maxHeight: "none" } : null),
        }}
      >
        <header
          className="flex min-h-12 shrink-0 cursor-move select-none items-center gap-3 border-b border-border px-4"
          onPointerDown={onHeaderDown}
        >
          <h2
            id={labelledBy ?? titleId}
            className="flex min-w-0 shrink-0 items-center gap-2 text-sm font-semibold text-text"
          >
            {icon}
            {title}
          </h2>
          <div className="flex min-w-0 flex-1 items-center gap-3">{headerExtra}</div>
          {!hideHeaderClose ? (
            <button
              type="button"
              className="grid size-8 shrink-0 place-items-center rounded-lg text-text-secondary outline-none transition-colors hover:bg-subtle hover:text-text focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label={messages.common.close}
              title={messages.common.close}
              onClick={onClose}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          ) : null}
        </header>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
        {footer ? (
          <footer className="flex shrink-0 justify-end gap-2 border-t border-border bg-raised px-4 py-3 pr-8">
            {footer}
          </footer>
        ) : null}
        <ResizeGrip
          label={messages.common.resizeDialog}
          onPointerDown={onResizeDown}
          onDoubleClick={() => setSize(null)}
        />
      </section>
    </div>
  );
}
