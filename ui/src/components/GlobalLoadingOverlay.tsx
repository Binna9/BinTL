import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { getGlobalLoadingVisible, subscribeGlobalLoading } from "@/lib/globalLoading";

const CIRCLE_COUNT = 3;

export function GlobalLoadingOverlay() {
  const { messages } = useLanguage();
  const visible = useSyncExternalStore(
    subscribeGlobalLoading,
    getGlobalLoadingVisible,
    () => false,
  );

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className={cn("global-loading-overlay", visible && "is-visible")}
      aria-hidden={!visible}
      aria-busy={visible}
    >
      <div className="global-loading-backdrop" />
      <div className="global-loading-stage" role="status" aria-live="polite" aria-label={messages.common.loading}>
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
        <p className="global-loading-label">{messages.common.loading}</p>
      </div>
    </div>,
    document.body,
  );
}
