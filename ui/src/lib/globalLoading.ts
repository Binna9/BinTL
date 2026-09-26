export type GlobalLoadingProgress = {
  current: number;
  total: number;
  detail: string;
};

export type GlobalLoadingSnapshot = {
  visible: boolean;
  label: string | null;
  progress: GlobalLoadingProgress | null;
};

type Listener = () => void;

const SHOW_DELAY_MS = 200;

let pending = 0;
let showTimer: number | undefined;
let snapshot: GlobalLoadingSnapshot = {
  visible: false,
  label: null,
  progress: null,
};
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener();
}

function replaceSnapshot(next: GlobalLoadingSnapshot) {
  snapshot = next;
  emit();
}

export function getGlobalLoadingSnapshot() {
  return snapshot;
}

export function subscribeGlobalLoading(listener: Listener) {
  listeners.add(listener);
  listener();
  return () => listeners.delete(listener);
}

export function setGlobalLoadingStatus(status: {
  label?: string | null;
  progress?: { current: number; total: number; detail?: string } | null;
}) {
  replaceSnapshot({
    ...snapshot,
    ...(status.label !== undefined ? { label: status.label } : {}),
    ...(status.progress !== undefined
      ? {
          progress: status.progress
            ? {
                current: status.progress.current,
                total: status.progress.total,
                detail: status.progress.detail ?? "",
              }
            : null,
        }
      : {}),
  });
}

export function beginGlobalLoading(immediate = false) {
  pending += 1;
  if (immediate) {
    if (showTimer !== undefined) {
      window.clearTimeout(showTimer);
      showTimer = undefined;
    }
    if (!snapshot.visible) {
      replaceSnapshot({ ...snapshot, visible: true });
    }
    return;
  }
  if (pending === 1 && showTimer === undefined) {
    showTimer = window.setTimeout(() => {
      showTimer = undefined;
      if (pending > 0 && !snapshot.visible) {
        replaceSnapshot({ ...snapshot, visible: true });
      }
    }, SHOW_DELAY_MS);
  }
}

export function endGlobalLoading() {
  pending = Math.max(0, pending - 1);
  if (pending > 0) return;

  if (showTimer !== undefined) {
    window.clearTimeout(showTimer);
    showTimer = undefined;
  }
  if (snapshot.visible || snapshot.label || snapshot.progress) {
    replaceSnapshot({ visible: false, label: null, progress: null });
  }
}
