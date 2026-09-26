import {
  createContext,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/cn";
import { useLanguage } from "@/i18n/LanguageProvider";
import { layout } from "@/lib/layout";

export function nextGridSelection(
  orderedIds: string[],
  current: readonly string[],
  anchor: string | null,
  clicked: string,
  mods: { shift: boolean; additive: boolean },
): { selected: string[]; anchor: string } {
  if (mods.shift && anchor) {
    const from = orderedIds.indexOf(anchor);
    const to = orderedIds.indexOf(clicked);
    if (from >= 0 && to >= 0) {
      const range = orderedIds.slice(Math.min(from, to), Math.max(from, to) + 1);
      return {
        selected: mods.additive ? [...new Set([...current, ...range])] : range,
        anchor,
      };
    }
  }
  if (mods.additive) {
    const next = new Set(current);
    if (next.has(clicked)) next.delete(clicked);
    else next.add(clicked);
    return { selected: [...next], anchor: clicked };
  }
  return { selected: [clicked], anchor: clicked };
}

function orderedRowIds(row: HTMLTableRowElement): string[] {
  const parent = row.parentElement;
  if (!parent) return row.dataset.gridRowId ? [row.dataset.gridRowId] : [];
  const ids: string[] = [];
  for (const child of parent.children) {
    if (child instanceof HTMLElement && child.dataset.gridRowId) ids.push(child.dataset.gridRowId);
  }
  return ids;
}

type GridSelectionApi = {
  selected: Set<string>;
  clickRow: (
    id: string,
    row: HTMLTableRowElement,
    event: ReactMouseEvent,
    extra?: { additive?: boolean },
  ) => void;
};

const GridSelectionContext = createContext<GridSelectionApi | null>(null);

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

export function EmptyState({
  icon,
  title,
  hint,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}) {
  const copy = hint
    ? { title, hint }
    : (() => {
        const match = title.match(/^(.+?[.。])\s+(.+)$/);
        return match ? { title: match[1], hint: match[2] } : { title };
      })();
  return (
    <div className={cn("flex w-full flex-1 flex-col items-center justify-center bg-surface px-6 py-12 text-center", className)}>
      {icon ? <div className="text-text-tertiary [&>svg]:size-10">{icon}</div> : null}
      <p className={cn("text-sm font-semibold", icon ? "mt-3" : undefined)}>{copy.title}</p>
      {copy.hint ? <p className="mt-1 max-w-sm text-xs text-text-tertiary">{copy.hint}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function DataGrid({
  headers,
  children,
  className,
  columnWidths,
  empty,
  selectedIds,
  onSelectedIdsChange,
}: {
  headers: string[];
  children: ReactNode;
  className?: string;
  columnWidths?: number[];
  empty?: ReactNode;
  selectedIds?: string[];
  onSelectedIdsChange?: (ids: string[]) => void;
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
  const [uncontrolled, setUncontrolled] = useState<string[]>([]);
  const picked = selectedIds ?? uncontrolled;
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const commitRef = useRef(onSelectedIdsChange ?? setUncontrolled);
  commitRef.current = onSelectedIdsChange ?? setUncontrolled;
  const anchorRef = useRef<string | null>(null);
  const selection = useMemo<GridSelectionApi>(
    () => ({
      selected: new Set(picked),
      clickRow(id, row, event, extra) {
        const next = nextGridSelection(orderedRowIds(row), pickedRef.current, anchorRef.current, id, {
          shift: event.shiftKey,
          additive: extra?.additive || event.ctrlKey || event.metaKey,
        });
        anchorRef.current = next.anchor;
        commitRef.current(next.selected);
      },
    }),
    [picked],
  );

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

  if (empty) {
    return (
      <div
        ref={wrapRef}
        className={cn(
          "flex min-w-0 w-full flex-1 flex-col bg-surface",
          !className && "min-h-[calc(100vh-18rem)]",
          className,
        )}
      >
        {empty}
      </div>
    );
  }

  return (
    <div ref={wrapRef} className={cn("scroll-pane min-w-0 w-full overflow-auto bg-workspace dark:bg-raised", className)}>
      <GridSelectionContext.Provider value={selection}>
        <table
          className="w-full border-collapse border-b border-border text-[13px]"
          style={{ width: "100%", minWidth: tableMinWidth, tableLayout: "fixed" }}
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
                    "group/th relative h-10 select-none overflow-hidden border-b border-border-strong bg-gradient-to-b from-raised to-subtle px-3 text-left text-[12px] font-semibold text-text-secondary",
                    "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.65)] dark:from-subtle dark:to-raised dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]",
                    "transition-colors hover:text-text",
                    !header && "px-0 text-center",
                    index < headers.length - 1 && "border-r border-border",
                    active === index && "text-text",
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
                        "absolute right-0 top-2.5 h-[calc(100%-1.25rem)] w-px bg-border",
                        "group-hover/th:bg-text-tertiary",
                        active === index && "bg-text-secondary",
                      )}
                    />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </GridSelectionContext.Provider>
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
  rowId,
}: {
  children: ReactNode;
  selected?: boolean;
  onClick?: (event: ReactMouseEvent<HTMLTableRowElement>) => void;
  rowId?: string;
}) {
  const autoId = useId();
  const id = rowId ?? autoId;
  const grid = useContext(GridSelectionContext);
  const [on, setOn] = useState(false);
  const active = Boolean(selected) || Boolean(grid?.selected.has(id)) || (selected === undefined && !grid && on);

  function isInteractive(event: ReactMouseEvent) {
    return Boolean((event.target as HTMLElement).closest("a, button, input, label"));
  }

  function selectCell(event: ReactMouseEvent) {
    const node = (event.target as HTMLElement).closest("[data-grid-select]");
    if (!(node instanceof HTMLElement) || !event.currentTarget.contains(node)) return null;
    return node;
  }

  return (
    <tr
      data-grid-row-id={id}
      aria-selected={active}
      className={cn(
        "group cursor-pointer border-b border-border/80 transition-colors duration-150",
        active && "bg-accent-subtle",
        !active && "odd:bg-surface even:bg-accent-subtle/55 hover:bg-accent-subtle dark:even:bg-white/4",
      )}
      onMouseDown={(event) => {
        if (selectCell(event) || event.shiftKey || event.ctrlKey || event.metaKey) {
          if (!isInteractive(event) || selectCell(event)) event.preventDefault();
          return;
        }
        if (isInteractive(event)) return;
      }}
      onClick={(event) => {
        const select = selectCell(event);
        if (select?.querySelector<HTMLInputElement>("input:disabled")) return;
        if (!select && isInteractive(event)) return;
        const modified = event.shiftKey || event.ctrlKey || event.metaKey;
        if (grid && (select || modified || !onClick)) {
          grid.clickRow(id, event.currentTarget, event, {
            additive: Boolean(select) && !event.shiftKey,
          });
          if (select || modified) return;
        }
        if (onClick) {
          onClick(event);
          return;
        }
        if (selected !== undefined || grid) return;
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
  select,
}: {
  children: ReactNode;
  mono?: boolean;
  muted?: boolean;
  warn?: boolean;
  title?: string;
  select?: boolean;
}) {
  return (
    <td
      data-grid-select={select || undefined}
      title={title}
      className={cn(
        "h-9 overflow-hidden text-ellipsis whitespace-nowrap border-r border-border/60 px-3 py-1.5 align-middle text-text last:border-r-0",
        select && "px-0 text-center",
        mono && "technical",
        muted && "text-text-secondary",
        warn && "bg-warning-subtle text-warning",
      )}
    >
      {select ? <span className="flex h-full items-center justify-center">{children}</span> : children}
    </td>
  );
}

if (import.meta.env.DEV) {
  const ids = ["a", "b", "c", "d"];
  console.assert(nextGridSelection(ids, [], null, "b", { shift: false, additive: false }).selected.join() === "b", "grid: click selects one");
  console.assert(nextGridSelection(ids, ["b"], "b", "d", { shift: false, additive: true }).selected.join() === "b,d", "grid: ctrl adds");
  console.assert(nextGridSelection(ids, ["b", "d"], "d", "d", { shift: false, additive: true }).selected.join() === "b", "grid: ctrl toggles off");
  console.assert(nextGridSelection(ids, ["a"], "a", "c", { shift: true, additive: false }).selected.join() === "a,b,c", "grid: shift range");
  console.assert(nextGridSelection(ids, ["d"], "a", "c", { shift: true, additive: true }).selected.join() === "d,a,b,c", "grid: shift+ctrl unions");
  console.assert(nextGridSelection(ids, ["a"], "a", "c", { shift: true, additive: false }).anchor === "a", "grid: shift keeps anchor");
  console.assert(nextGridSelection(ids, ["a"], "a", "b", { shift: false, additive: true }).selected.join() === "a,b", "grid: checkbox toggles add");
}
