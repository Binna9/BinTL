import {
  KeyboardEvent,
  ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

export type SelectOption = {
  value: string;
  label: ReactNode;
  disabled?: boolean;
};

type SelectProps = {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  menuClassName?: string;
  onChange?: (value: string) => void;
};

const MENU_MAX_HEIGHT = 256;
const MENU_GAP = 4;
const CLOSE_EVENT = "bintl:select-close";

type MenuPos = {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
};

function firstEnabledValue(options: SelectOption[], placeholder?: string): string {
  if (placeholder !== undefined) return "";
  return options.find((option) => !option.disabled)?.value ?? "";
}

export function Select({
  options,
  value,
  defaultValue,
  name,
  placeholder,
  disabled,
  required,
  className,
  menuClassName,
  onChange,
}: SelectProps) {
  const isControlled = value !== undefined;
  const fallback = defaultValue ?? firstEnabledValue(options, placeholder);
  const [internal, setInternal] = useState(fallback);
  const current = isControlled ? value : internal;
  const menuOptions = useMemo<SelectOption[]>(
    () =>
      placeholder !== undefined
        ? [{ value: "", label: placeholder }, ...options]
        : options,
    [options, placeholder],
  );
  const selected = menuOptions.find((option) => option.value === current);
  const listId = useId();
  const instanceId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const [active, setActive] = useState(current);

  const enabled = useMemo(
    () => menuOptions.filter((option) => !option.disabled),
    [menuOptions],
  );

  function commit(next: string) {
    if (!isControlled) setInternal(next);
    onChange?.(next);
    setOpen(false);
    triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    setActive(
      menuOptions.some((option) => option.value === current)
        ? current
        : (enabled[0]?.value ?? ""),
    );
    window.dispatchEvent(new CustomEvent(CLOSE_EVENT, { detail: instanceId }));
    const onCloseOthers = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== instanceId) setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onViewport = () => setOpen(false);
    window.addEventListener(CLOSE_EVENT, onCloseOthers);
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("resize", onViewport);
    window.addEventListener("scroll", onViewport, true);
    return () => {
      window.removeEventListener(CLOSE_EVENT, onCloseOthers);
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("resize", onViewport);
      window.removeEventListener("scroll", onViewport, true);
    };
  }, [open, current, enabled, instanceId, menuOptions]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - MENU_GAP;
    const spaceAbove = rect.top - MENU_GAP;
    const openUp = spaceBelow < 148 && spaceAbove > spaceBelow;
    const maxHeight = Math.min(
      MENU_MAX_HEIGHT,
      Math.max(88, (openUp ? spaceAbove : spaceBelow) - 8),
    );
    const width = Math.min(Math.max(rect.width, 168), window.innerWidth - 16);
    let left = rect.left;
    if (left + width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - 8 - width);
    }
    setPos(
      openUp
        ? { bottom: window.innerHeight - rect.top + MENU_GAP, left, width, maxHeight }
        : { top: rect.bottom + MENU_GAP, left, width, maxHeight },
    );
  }, [open, menuOptions.length]);

  useEffect(() => {
    if (!open) return;
    const node = menuRef.current?.querySelector<HTMLElement>("[data-active]");
    node?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  useEffect(() => {
    if (!name) return;
    const form = triggerRef.current?.closest("form");
    if (!form) return;
    const onReset = () => {
      if (!isControlled) setInternal(fallback);
    };
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [name, isControlled, fallback]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    const opens =
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Enter" ||
      event.key === " ";
    if (opens) {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        const pick = enabled.find((option) => option.value === active) ?? enabled[0];
        if (pick) commit(pick.value);
        return;
      }
      const index = Math.max(0, enabled.findIndex((option) => option.value === active));
      const next =
        event.key === "ArrowDown"
          ? enabled[Math.min(enabled.length - 1, index + 1)]
          : enabled[Math.max(0, index - 1)];
      if (next) setActive(next.value);
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  }

  const display = selected ? (
    current === "" ? (
      <span className="text-text-tertiary">{selected.label}</span>
    ) : (
      selected.label
    )
  ) : (
    <span className="text-text-tertiary">{placeholder ?? ""}</span>
  );

  return (
    <div className={cn("relative min-w-0 w-full", className)}>
      {name ? <input type="hidden" name={name} value={current} required={required} /> : null}
      <button
        ref={triggerRef}
        type="button"
        className={cn("field-control field-select-trigger", open && "field-select-open")}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => {
          if (!disabled) setOpen((was) => !was);
        }}
        onKeyDown={onKeyDown}
      >
        <span className="min-w-0 flex-1 truncate">{display}</span>
        <motion.span
          className="grid shrink-0 place-items-center text-text-tertiary"
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.18 }}
          aria-hidden="true"
        >
          <ChevronDown className="size-3.5" />
        </motion.span>
      </button>
      {createPortal(
        <AnimatePresence>
          {open && pos ? (
            <motion.div
              ref={menuRef}
              id={listId}
              role="listbox"
              className={cn("field-select-menu", menuClassName)}
              style={pos}
              initial={{ opacity: 0, y: pos.bottom != null ? 6 : -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: pos.bottom != null ? 4 : -4, scale: 0.98 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            >
              {menuOptions.map((option, index) => {
                const isSelected = option.value === current;
                const isActive = option.value === active;
                return (
                  <div
                    key={option.value ? option.value : `empty-${index}`}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={option.disabled || undefined}
                    data-active={isActive || undefined}
                    className={cn(
                      "field-select-option",
                      isSelected && "is-selected",
                      isActive && "is-active",
                      option.disabled && "is-disabled",
                      option.value === "" && "is-placeholder",
                    )}
                    onMouseEnter={() => {
                      if (!option.disabled) setActive(option.value);
                    }}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      if (!option.disabled) commit(option.value);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {isSelected ? (
                      <Check className="size-3.5 shrink-0" aria-hidden="true" />
                    ) : null}
                  </div>
                );
              })}
            </motion.div>
          ) : null}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
