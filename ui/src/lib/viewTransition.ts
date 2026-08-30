import { flushSync } from "react-dom";

/** Soft cross-fade via the View Transitions API (same feel as locale switch). */
export function withViewTransition(apply: () => void): void {
  const start = document.startViewTransition?.bind(document);
  if (start && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    start(() => {
      flushSync(apply);
    });
    return;
  }
  flushSync(apply);
}
