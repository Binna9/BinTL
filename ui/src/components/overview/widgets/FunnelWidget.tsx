import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { PanelBody } from "@/components/ui/panel";
import { useLanguage } from "@/i18n/LanguageProvider";
import { useDashboard } from "@/hooks/overview/DashboardContext";
import type { ChipKind } from "@/types/chip";

const TONE: Record<ChipKind, string> = {
  extract: "var(--theme-accent)",
  transform: "var(--theme-success)",
  load: "var(--theme-warning)",
  sql: "var(--theme-text)",
  validation: "var(--theme-text-tertiary)",
  serve: "#14b8a6",
};

export function FunnelWidget() {
  const { messages } = useLanguage();
  const { model } = useDashboard();
  const [ready, setReady] = useState(false);

  const items = useMemo(
    () => [
      { id: "extract" as const, label: messages.overview.extract, rate: model.extractRate },
      { id: "transform" as const, label: messages.overview.transform, rate: model.transformRate },
      { id: "load" as const, label: messages.overview.load, rate: model.loadRate },
      { id: "sql" as const, label: messages.workspace.sql, rate: model.sqlRate },
      { id: "serve" as const, label: messages.workspace.serve, rate: model.serveRate },
      { id: "validation" as const, label: messages.workspace.validation, rate: model.validationRate },
    ],
    [messages, model],
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <PanelBody className="flex h-full min-h-0 flex-col">
      <ul className="dash-rate min-h-0 flex-1" aria-label={messages.overview.funnelSeries}>
        {items.map((item) => {
          const fill = ready && item.rate != null ? item.rate : 0;
          return (
            <li key={item.id}>
              <Link
                to={`/history?tab=chip&kind=${item.id}`}
                className="dash-rate-row"
                style={{ "--dash-rate-tone": TONE[item.id] } as CSSProperties}
                aria-label={item.label}
                title={item.rate == null ? messages.overview.noRate : messages.overview.successRate(item.rate)}
              >
                <span className="dash-rate-meta">
                  <i />
                  <em>{item.label}</em>
                  <strong>
                    {item.rate == null ? messages.overview.noRate : item.rate}
                    {item.rate != null ? <span>%</span> : null}
                  </strong>
                </span>
                <span className="dash-rate-track">
                  <span className="dash-rate-fill" style={{ width: `${fill}%` }} />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </PanelBody>
  );
}
