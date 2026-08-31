import {
  MouseEvent as ReactMouseEvent,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/cn";
import { useLanguage } from "@/i18n/LanguageProvider";
import { layout } from "@/lib/layout";

function widthsFor(headers: string[], previous: number[] = []): number[] {
  return headers.map((_, index) => previous[index] ?? layout.grid.defaultColumnWidth);
}

function measureText(text: string): number {
  let units = 0;
  for (const char of text) {
    units += char.charCodeAt(0) > 127 ? 2 : 1;
  }
  return units;
}

export function columnWidthsForContent(headers: string[], rows: string[][]): number[] {
  const sample = rows.slice(0, 80);
  return headers.map((header, index) => {
    let units = measureText(header);
    for (const row of sample) {
      units = Math.max(units, measureText(row[index] ?? ""));
    }
    return Math.min(
      layout.grid.maxColumnWidth,
      Math.max(layout.grid.minColumnWidth, units * 8 + 24),
    );
  });
}

function scaleToFill(widths: number[], available: number): number[] {
  if (available <= 0 || widths.length === 0) return widths;
  const sum = widths.reduce((total, width) => total + width, 0);
  if (sum >= available) return widths;
  const min = layout.grid.minColumnWidth;
  const scaled = widths.map((width) => Math.max(min, Math.floor((width / sum) * available)));
  const used = scaled.slice(0, -1).reduce((total, width) => total + width, 0);
  scaled[scaled.length - 1] = Math.max(min, available - used);
  return scaled;
}

export function DataGrid({
  headers,
  children,
  className,
  columnWidths,
}: {
  headers: string[];
  children: ReactNode;
  className?: string;
  columnWidths?: number[];
}) {
  const { messages } = useLanguage();
  const headerKey = headers.join("\u0001");
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hostWidth, setHostWidth] = useState(0);
  const [widths, setWidths] = useState(() =>
    columnWidths?.length === headers.length ? columnWidths : widthsFor(headers),
  );
  const [active, setActive] = useState<number | null>(null);
  const drag = useRef<{ index: number; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    setWidths(
      columnWidths?.length === headers.length ? columnWidths : widthsFor(headers),
    );
  }, [headerKey]);

  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setHostWidth(Math.floor(width));
    });
    observer.observe(node);
    setHostWidth(Math.floor(node.clientWidth));
    return () => observer.disconnect();
  }, [headerKey]);

  const colWidths = useMemo(
    () => scaleToFill(widths, hostWidth),
    [widths, hostWidth],
  );

  useEffect(() => {
    function onMove(event: MouseEvent) {
      const current = drag.current;
      if (!current) return;
      const next = Math.max(
        layout.grid.minColumnWidth,
        current.startWidth + (event.clientX - current.startX),
      );
      setWidths((prev) => {
        const filled = scaleToFill(prev, hostWidth);
        const copy = [...filled];
        copy[current.index] = next;
        return copy;
      });
    }

    function onUp() {
      if (!drag.current) return;
      drag.current = null;
      setActive(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [hostWidth]);

  function onResizeStart(index: number, event: ReactMouseEvent<HTMLSpanElement>) {
    event.preventDefault();
    event.stopPropagation();
    drag.current = {
      index,
      startX: event.clientX,
      startWidth: colWidths[index] ?? layout.grid.defaultColumnWidth,
    };
    setActive(index);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  const tableMinWidth = colWidths.reduce((sum, width) => sum + width, 0);

  return (
    <div ref={wrapRef} className={cn("scroll-pane min-w-0 w-full overflow-auto", className)}>
      <table
        className="border-collapse text-[13px]"
        style={{ width: tableMinWidth, minWidth: tableMinWidth, tableLayout: "fixed" }}
      >
        <colgroup>
          {headers.map((header, index) => (
            <col key={`${index}-${header}`} style={{ width: colWidths[index] }} />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-10">
          <tr>
            {headers.map((header, index) => (
              <th
                key={`${index}-${header}`}
                className={cn(
                  "group/th relative h-9 select-none overflow-hidden border-b-2 border-border-strong bg-subtle px-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-text-secondary",
                  "transition-colors hover:bg-accent-subtle hover:text-accent",
                  index < headers.length - 1 && "border-r border-border",
                  active === index && "bg-accent-subtle text-accent",
                )}
              >
                <span className="block truncate">{header}</span>
                <span
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={messages.common.resizeColumn(header)}
                  className="absolute inset-y-0 right-0 z-10 w-2 cursor-col-resize"
                  onMouseDown={(event) => onResizeStart(index, event)}
                  onDoubleClick={() => {
                    setWidths((prev) => {
                      const copy = [...prev];
                      copy[index] = columnWidths?.[index] ?? layout.grid.defaultColumnWidth;
                      return copy;
                    });
                  }}
                >
                  <span
                    className={cn(
                      "absolute right-0 top-2 h-[calc(100%-1rem)] w-px bg-border-strong/70",
                      "group-hover/th:bg-accent",
                      active === index && "bg-accent",
                    )}
                  />
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="bg-surface">{children}</tbody>
      </table>
    </div>
  );
}

export function EmptyGridRow({ cols, text }: { cols: number; text: string }) {
  return (
    <tr>
      <td colSpan={cols} className="px-4 py-12 text-center text-[13px] text-text-tertiary">
        {text}
      </td>
    </tr>
  );
}

export function GridRow({
  children,
  selected,
  onClick,
}: {
  children: ReactNode;
  selected?: boolean;
  onClick?: (event: ReactMouseEvent<HTMLTableRowElement>) => void;
}) {
  const [on, setOn] = useState(false);
  const active = selected ?? on;

  return (
    <tr
      className={cn(
        "group cursor-pointer border-b border-border/70 transition-colors duration-150 last:border-b-0",
        active && "bg-accent-subtle",
        !active && "odd:bg-surface even:bg-subtle/35 hover:bg-accent-subtle/45",
      )}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a, button, input, label")) return;
        if (onClick) {
          onClick(event);
          return;
        }
        if (selected !== undefined) return;
        setOn((value) => !value);
      }}
    >
      {children}
    </tr>
  );
}

export function GridCell({
  children,
  mono,
  muted,
  warn,
  title,
}: {
  children: ReactNode;
  mono?: boolean;
  muted?: boolean;
  warn?: boolean;
  title?: string;
}) {
  return (
    <td
      title={title}
      className={cn(
        "h-9 overflow-hidden text-ellipsis whitespace-nowrap border-r border-border/60 px-3 py-1.5 align-middle text-text last:border-r-0",
        mono && "technical",
        muted && "text-text-secondary",
        warn && "bg-warning-subtle text-warning",
      )}
    >
      {children}
    </td>
  );
}
