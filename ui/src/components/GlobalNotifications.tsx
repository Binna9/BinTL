import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bell,
  CircleAlert,
  CircleCheck,
  Info,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/i18n/LanguageProvider";
import {
  DialogNotification,
  NotificationEvent,
  subscribeNotifications,
  ToastPosition,
  ToastStatus,
  ToastNotification,
} from "@/lib/notifications";
import { cn } from "@/lib/cn";

const MAX_TOASTS = 5;

const TOAST_POSITIONS: ToastPosition[] = [
  "top-left",
  "top-center",
  "top-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

const POSITION_CLASSES: Record<ToastPosition, string> = {
  "top-left": "left-4 top-4 items-start",
  "top-center": "left-1/2 top-4 -translate-x-1/2 items-center",
  "top-right": "right-4 top-4 items-end",
  "bottom-left": "bottom-4 left-4 items-start",
  "bottom-center": "bottom-4 left-1/2 -translate-x-1/2 items-center",
  "bottom-right": "bottom-4 right-4 items-end",
};

const STATUS_STYLE: Record<
  ToastStatus,
  {
    icon: LucideIcon;
    iconClass: string;
    accentClass: string;
    backgroundClass: string;
  }
> = {
  success: {
    icon: CircleCheck,
    iconClass: "text-success",
    accentClass: "bg-success",
    backgroundClass: "bg-success-subtle/95",
  },
  error: {
    icon: CircleAlert,
    iconClass: "text-danger",
    accentClass: "bg-danger",
    backgroundClass: "bg-danger-subtle/95",
  },
  warning: {
    icon: TriangleAlert,
    iconClass: "text-warning",
    accentClass: "bg-warning",
    backgroundClass: "bg-warning-subtle/95",
  },
  info: {
    icon: Info,
    iconClass: "text-accent",
    accentClass: "bg-accent",
    backgroundClass: "bg-accent-subtle/95",
  },
  default: {
    icon: Bell,
    iconClass: "text-text-secondary",
    accentClass: "bg-border-strong",
    backgroundClass: "bg-surface/95",
  },
};

export function GlobalNotifications() {
  const { messages } = useLanguage();
  const [toasts, setToasts] = useState<ToastNotification[]>([]);
  const [dialogs, setDialogs] = useState<DialogNotification[]>([]);
  const toastTimers = useRef(new Map<string, number>());

  const removeToast = useCallback((id: string) => {
    const timer = toastTimers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      toastTimers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  useEffect(() => {
    function onNotification(event: NotificationEvent) {
      if (event.type === "dismiss-toast") {
        removeToast(event.id);
        return;
      }
      if (event.type === "show-dialog") {
        setDialogs((current) => [...current, event.notification]);
        return;
      }

      const toast = event.notification;
      setToasts((current) => {
        const next = [...current, toast];
        const removed = next.slice(0, Math.max(0, next.length - MAX_TOASTS));
        removed.forEach((item) => {
          const timer = toastTimers.current.get(item.id);
          if (timer !== undefined) window.clearTimeout(timer);
          toastTimers.current.delete(item.id);
        });
        return next.slice(-MAX_TOASTS);
      });
      const timer = window.setTimeout(() => removeToast(toast.id), toast.duration);
      toastTimers.current.set(toast.id, timer);
    }

    const unsubscribe = subscribeNotifications(onNotification);
    const timers = toastTimers.current;
    return () => {
      unsubscribe();
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, [removeToast]);

  const activeDialog = dialogs[0] ?? null;

  function settleDialog(confirmed: boolean) {
    if (!activeDialog) return;
    activeDialog.resolve(confirmed);
    setDialogs((current) => current.slice(1));
  }

  useEffect(() => {
    if (!activeDialog) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Enter" || event.shiftKey || event.repeat) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.isContentEditable) return;
      if (
        target instanceof HTMLTextAreaElement
        || (target instanceof HTMLInputElement && target.type !== "button" && target.type !== "submit")
        || target instanceof HTMLSelectElement
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      settleDialog(true);
    }
    // Capture so parent popups (e.g. workspace manage) don't swallow Enter first.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activeDialog?.id]);

  return (
    <>
      <AppDialog
        open={Boolean(activeDialog)}
        title={activeDialog?.title ?? ""}
        icon={
          activeDialog?.tone === "danger" ? (
            <TriangleAlert className="size-4 text-danger" aria-hidden="true" />
          ) : (
            <CircleAlert className="size-4 text-accent" aria-hidden="true" />
          )
        }
        className="h-auto max-h-[min(32rem,90vh)] w-[min(28rem,94vw)]"
        minWidth={360}
        minHeight={220}
        zIndex={250}
        onClose={() => settleDialog(false)}
        footer={
          activeDialog ? (
            <>
              {activeDialog.type === "confirm" ? (
                <Button type="button" variant="secondary" onClick={() => settleDialog(false)}>
                  {activeDialog.cancelLabel ?? messages.common.cancel}
                </Button>
              ) : null}
              <Button
                type="button"
                autoFocus
                variant={activeDialog.tone === "danger" ? "danger" : "primary"}
                onClick={() => settleDialog(true)}
              >
                {activeDialog.confirmLabel ?? messages.common.confirm}
              </Button>
            </>
          ) : null
        }
      >
        <div className="overflow-auto px-5 py-6">
          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-text-secondary">
            {activeDialog?.message}
          </p>
        </div>
      </AppDialog>

      {TOAST_POSITIONS.map((position) => (
        <div
          key={position}
          className={cn(
            "pointer-events-none fixed z-[300] flex max-h-[calc(100vh-2rem)] flex-col gap-3",
            POSITION_CLASSES[position],
          )}
          aria-live="polite"
        >
          {toasts
            .filter((toast) => toast.position === position)
            .map((toast) => {
              const style = STATUS_STYLE[toast.status];
              const StatusIcon = style.icon;
              return (
                <article
                  key={toast.id}
                  role={toast.status === "error" ? "alert" : "status"}
                  className={cn(
                    "notification-toast pointer-events-auto relative w-[min(23rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border shadow-xl backdrop-blur-md",
                    style.backgroundClass,
                  )}
                >
                  <div className={cn("absolute inset-y-0 left-0 w-1", style.accentClass)} />
                  <div className="flex items-start gap-3 p-4 pl-5">
                    <StatusIcon
                      className={cn("mt-0.5 size-5 shrink-0", style.iconClass)}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold leading-5 text-text">{toast.title}</h3>
                      {toast.message ? (
                        <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-text-secondary">
                          {toast.message}
                        </p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="grid size-7 shrink-0 place-items-center rounded-lg text-text-tertiary transition-colors hover:bg-surface/70 hover:text-text"
                      aria-label={messages.common.close}
                      onClick={() => removeToast(toast.id)}
                    >
                      <X className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                  <div className="absolute inset-x-0 bottom-0 h-0.5 bg-border/60">
                    <div
                      className={cn(
                        "notification-toast-progress h-full w-full",
                        style.accentClass,
                      )}
                      style={{ animationDuration: `${toast.duration}ms` }}
                    />
                  </div>
                </article>
              );
            })}
        </div>
      ))}
    </>
  );
}
