import { useState, type DragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AppWindow, ChevronDown, DatabaseZap, FileOutput, Folder, FolderOpen, Layers, Pencil, Settings2, Spline, Workflow, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Messages } from "@/i18n/ko";
import { cn } from "@/lib/cn";
import type { Chip, ChipEdge, ChipEdgeKind } from "@/types/chip";
import {
  CANVAS_H, CANVAS_W, MINIMAP_H, MINIMAP_W, NODE_H, NODE_W,
  flowMarks, wireTone,
  type EdgeGeometry, type Point, type PortSide,
} from "@/features/workspace/workspaceCanvasModel";

export function WorkspaceInfoRow({
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

export function WorkspaceBrowserPanel({
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

export function ShortcutHint({ keys, label }: { keys: string[]; label: string }) {
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

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function ToolIconButton({
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

export function ChipLinkHandle({
  side,
  label,
  kind,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
}: {
  side: PortSide;
  label: string;
  kind: ChipEdgeKind;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerCancel?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onLostPointerCapture?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
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
      onLostPointerCapture={onLostPointerCapture}
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

export function EdgeWire({
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

export function CollapsibleRailSection({
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

export function LayerGroup({
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

export function LayerRow({
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

export function WorkspaceLayers({
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
  const loads = chips.filter((chip) => chip.kind === "load");
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
      <LayerGroup title={messages.workspace.layerLoads(loads.length)}>
        {loads.length === 0 ? (
          <li className="px-2 py-1 text-[12px] text-text-tertiary">{messages.workspace.emptyLayerGroup}</li>
        ) : loads.map((chip) => (
          <LayerRow key={chip.id} selected={selectedChipIds.includes(chip.id)} icon={FileOutput}
            iconClassName="text-warning" label={chip.name} onClick={(event) => onSelectChip(chip.id, event)}
            editTitle={messages.workspace.chipMenuProperties} onEdit={() => onEditChip(chip)} />
        ))}
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

export function WorkspaceMinimap({
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
                chip.kind === "extract" ? "is-extract" : chip.kind === "load" ? "is-load" : "is-transform",
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
