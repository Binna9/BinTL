import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Info,
  Pencil,
  Play,
  Settings2,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { Chip } from "@/types/chip";
import type { Messages } from "@/i18n/ko";

const MENU_GAP = 8;

export type ChipContextMenuState = {
  chip: Chip;
};

type MenuItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  tone?: "danger";
  disabled?: boolean;
  onSelect: () => void;
};

function placeBesideChip(chipId: string, panel: HTMLElement | null) {
  const node = document.querySelector<HTMLElement>(`[data-chip-id="${chipId}"]`);
  if (!node) return { left: MENU_GAP, top: MENU_GAP };
  const rect = node.getBoundingClientRect();
  const width = panel?.offsetWidth ?? 184;
  const height = panel?.offsetHeight ?? 180;
  const pad = 8;
  let left = rect.right + MENU_GAP;
  if (left + width > window.innerWidth - pad) left = rect.left - width - MENU_GAP;
  left = Math.min(left, window.innerWidth - width - pad);
  left = Math.max(pad, left);
  let top = rect.top;
  top = Math.min(top, window.innerHeight - height - pad);
  top = Math.max(pad, top);
  return { left, top };
}

export function ChipContextMenu({
  menu,
  messages,
  busy,
  onClose,
  onRun,
  onInfo,
  onProperties,
  onEdit,
  onDelete,
}: {
  menu: ChipContextMenuState | null;
  messages: Messages;
  busy?: boolean;
  onClose: () => void;
  onRun: (chip: Chip) => void;
  onInfo: (chip: Chip) => void;
  onProperties: (chip: Chip) => void;
  onEdit: (chip: Chip) => void;
  onDelete: (chip: Chip) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!menu) return;
    setPos(placeBesideChip(menu.chip.id, panelRef.current));
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    function onPointerDown(event: PointerEvent) {
      if (panelRef.current?.contains(event.target as Node)) return;
      onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    function onScroll() {
      onClose();
    }
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  const chip = menu.chip;
  const items: MenuItem[] = [
    {
      id: "run",
      label: messages.workspace.chipMenuRun,
      icon: Play,
      disabled: busy,
      onSelect: () => onRun(chip),
    },
    {
      id: "info",
      label: messages.workspace.chipMenuInfo,
      icon: Info,
      onSelect: () => onInfo(chip),
    },
    {
      id: "properties",
      label: messages.workspace.chipMenuProperties,
      icon: Settings2,
      onSelect: () => onProperties(chip),
    },
  ];
  if (chip.kind === "transform") {
    items.push({
      id: "edit",
      label: messages.workspace.chipMenuEditSteps,
      icon: Pencil,
      onSelect: () => onEdit(chip),
    });
  }
  items.push({
    id: "delete",
    label: messages.common.delete,
    icon: Trash2,
    tone: "danger",
    disabled: busy,
    onSelect: () => onDelete(chip),
  });

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={chip.name}
      className="chip-context-menu fixed z-[240] min-w-[11.5rem] overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-[0_10px_28px_rgba(15,23,42,0.14)] dark:shadow-[0_14px_32px_rgba(0,0,0,0.48)]"
      style={{ left: pos.left, top: pos.top }}
    >
      <p className="truncate border-b border-border px-3 py-1.5 text-[11px] font-semibold text-text-tertiary">
        {chip.name}
      </p>
      <ul className="py-1">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.id}>
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] outline-none transition-colors",
                  "hover:bg-subtle focus-visible:bg-subtle disabled:cursor-not-allowed disabled:opacity-45",
                  item.tone === "danger" ? "text-danger" : "text-text",
                )}
                onClick={() => {
                  onClose();
                  item.onSelect();
                }}
              >
                <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>,
    document.body,
  );
}
