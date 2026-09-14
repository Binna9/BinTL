import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import {
  getGlobalLoadingSnapshot,
  subscribeGlobalLoading,
} from "@/lib/globalLoading";

const CIRCLE_COUNT = 3;

export function GlobalLoadingOverlay() {
  const { messages } = useLanguage();
  const snapshot = useSyncExternalStore(
    subscribeGlobalLoading,
    getGlobalLoadingSnapshot,
    getGlobalLoadingSnapshot,
  );
  const label = snapshot.label ?? messages.common.loading;
  const progress = snapshot.progress;
  const ratio =
    progress && progress.total > 0
      ? Math.min(1, Math.max(0, progress.current / progress.total))
      : 0;

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className={cn("global-loading-overlay", snapshot.visible && "is-visible")}
      aria-hidden={!snapshot.visible}
      aria-busy={snapshot.visible}
    >
      <div className="global-loading-backdrop" />
      <div className="global-loading-stage" role="status" aria-live="polite" aria-label={label}>
        <div className="global-loading-orbit" aria-hidden="true">
          {Array.from({ length: CIRCLE_COUNT }, (_, index) => (
            <div
              key={index}
              className="global-loading-circle"
              style={{ transform: `rotate(${index * 70}deg)` }}
            >
              <div className="global-loading-circle-inner" />
            </div>
          ))}
        </div>
        <p className="global-loading-label">{label}</p>
        {progress?.detail ? <p className="global-loading-detail">{progress.detail}</p> : null}
        {progress && progress.total > 0 ? (
          <div className="global-loading-progress" aria-hidden="true">
            <div className="global-loading-progress-bar" style={{ width: `${ratio * 100}%` }} />
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
