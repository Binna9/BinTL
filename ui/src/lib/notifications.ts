export type ToastStatus = "success" | "error" | "warning" | "info" | "default";

export type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export interface AlertOptions {
  confirmLabel?: string;
}

export interface ConfirmOptions {
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
}

export interface ToastNotification {
  id: string;
  title: string;
  message: string;
  status: ToastStatus;
  duration: number;
  position: ToastPosition;
}

export interface DialogNotification {
  id: string;
  type: "alert" | "confirm";
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone: "default" | "danger";
  resolve: (confirmed: boolean) => void;
}

export type NotificationEvent =
  | { type: "show-toast"; notification: ToastNotification }
  | { type: "dismiss-toast"; id: string }
  | { type: "show-dialog"; notification: DialogNotification };

type NotificationListener = (event: NotificationEvent) => void;

const listeners = new Set<NotificationListener>();
const pendingEvents: NotificationEvent[] = [];

function notificationId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function publish(event: NotificationEvent): void {
  if (listeners.size === 0) {
    pendingEvents.push(event);
    return;
  }
  listeners.forEach((listener) => listener(event));
}

export function subscribeNotifications(listener: NotificationListener): () => void {
  listeners.add(listener);
  if (pendingEvents.length > 0) {
    pendingEvents.splice(0).forEach(listener);
  }
  return () => listeners.delete(listener);
}

export function showToast(
  title: string,
  message = "",
  status: ToastStatus = "default",
  duration = 5000,
  position: ToastPosition = "top-right",
): string {
  const id = notificationId();
  publish({
    type: "show-toast",
    notification: {
      id,
      title,
      message,
      status,
      duration: Math.max(1000, duration),
      position,
    },
  });
  return id;
}

export function dismissToast(id: string): void {
  publish({ type: "dismiss-toast", id });
}

export function showAlert(
  title: string,
  message: string,
  options: AlertOptions = {},
): Promise<void> {
  return new Promise((resolve) => {
    publish({
      type: "show-dialog",
      notification: {
        id: notificationId(),
        type: "alert",
        title,
        message,
        confirmLabel: options.confirmLabel,
        tone: "default",
        resolve: () => resolve(),
      },
    });
  });
}

export function showConfirm(
  title: string,
  message: string,
  options: ConfirmOptions = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    publish({
      type: "show-dialog",
      notification: {
        id: notificationId(),
        type: "confirm",
        title,
        message,
        confirmLabel: options.confirmLabel,
        cancelLabel: options.cancelLabel,
        tone: options.tone ?? "default",
        resolve,
      },
    });
  });
}
