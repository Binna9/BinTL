type Listener = (visible: boolean) => void;

const SHOW_DELAY_MS = 200;

let pending = 0;
let visible = false;
let showTimer: number | undefined;
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener(visible);
}

export function getGlobalLoadingVisible() {
  return visible;
}

export function subscribeGlobalLoading(listener: Listener) {
  listeners.add(listener);
  listener(visible);
  return () => listeners.delete(listener);
}

export function beginGlobalLoading() {
  pending += 1;
  if (pending === 1 && showTimer === undefined) {
    showTimer = window.setTimeout(() => {
      showTimer = undefined;
      if (pending > 0 && !visible) {
        visible = true;
        emit();
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
  if (visible) {
    visible = false;
    emit();
  }
}
