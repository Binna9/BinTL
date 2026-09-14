import { useEffect, useMemo, useState, type CSSProperties } from "react";
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
};

const BOX = 220;
const CX = 110;
const CY = 108;
const SWEEP = 0.75;
const RADII = [94, 78, 62, 46, 30];

type RateItem = { id: ChipKind; label: string; rate: number | null };

function ringCirc(radius: number) {
  return 2 * Math.PI * radius;
}

export function FunnelWidget() {
  const { messages } = useLanguage();
  const { model } = useDashboard();
  const [hidden, setHidden] = useState<ChipKind[]>([]);
  const [hot, setHot] = useState<ChipKind | null>(null);
  const [ready, setReady] = useState(false);

  const items = useMemo<RateItem[]>(
    () => [
      { id: "extract", label: messages.overview.extract, rate: model.extractRate },
      { id: "transform", label: messages.overview.transform, rate: model.transformRate },
      { id: "load", label: messages.overview.load, rate: model.loadRate },
      { id: "sql", label: messages.workspace.sql, rate: model.sqlRate },
      { id: "validation", label: messages.workspace.validation, rate: model.validationRate },
    ],
    [messages, model],
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  function toggle(id: ChipKind) {
    setHidden((prev) => (prev.includes(id) ? prev.filter((kind) => kind !== id) : [...prev, id]));
  }

  const focus = items.find((item) => item.id === hot) ?? null;

  return (
    <PanelBody className="flex h-full min-h-0 flex-col">
      <div className="dash-rate" onMouseLeave={() => setHot(null)}>
        <div className="dash-rate-stage">
          <svg className="dash-rate-rings" viewBox={`0 0 ${BOX} ${BOX}`} aria-hidden="true">
            {items.map((item, index) => {
              const on = !hidden.includes(item.id);
              const radius = RADII[index] ?? RADII[RADII.length - 1];
              const circ = ringCirc(radius);
              const track = circ * SWEEP;
              const pct = ready && on && item.rate != null ? item.rate / 100 : 0;
              return (
                <g
                  key={item.id}
                  className="dash-rate-ring"
                  data-off={!on || undefined}
                  data-hot={hot === item.id || undefined}
                  style={{ "--dash-rate-tone": TONE[item.id] } as CSSProperties}
                  transform={`rotate(135 ${CX} ${CY})`}
                >
                  <circle className="dash-rate-track" cx={CX} cy={CY} r={radius} strokeDasharray={`${track} ${circ}`} />
                  <circle
                    className="dash-rate-fill"
                    cx={CX}
                    cy={CY}
                    r={radius}
                    strokeDasharray={`${track * pct} ${circ}`}
                  />
                  <circle
                    className="dash-rate-hit"
                    cx={CX}
                    cy={CY}
                    r={radius}
                    strokeDasharray={`${track} ${circ}`}
                    onMouseEnter={() => setHot(item.id)}
                    onClick={() => toggle(item.id)}
                  />
                </g>
              );
            })}
          </svg>
          <div className="dash-rate-center">
            {focus ? (
              <>
                <strong>
                  {focus.rate == null ? "—" : `${focus.rate}`}
                  {focus.rate != null ? <span>%</span> : null}
                </strong>
                <em>{focus.label}</em>
              </>
            ) : null}
          </div>
        </div>
        <ul className="dash-chart-legend" aria-label={messages.overview.funnelSeries}>
          {items.map((item) => {
            const on = !hidden.includes(item.id);
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className="dash-chart-legend-item"
                  style={{ color: TONE[item.id] }}
                  aria-pressed={on}
                  aria-label={item.label}
                  onMouseEnter={() => setHot(item.id)}
                  onFocus={() => setHot(item.id)}
                  onClick={() => toggle(item.id)}
                >
                  <i style={{ background: on ? "currentColor" : "var(--color-border-strong)" }} />
                  <span className="min-w-0 flex-1 truncate text-left text-text-secondary">{item.label}</span>
                  <strong title={item.rate == null ? messages.overview.noRate : messages.overview.successRate(item.rate)}>
                    {item.rate == null ? "—" : `${item.rate}%`}
                  </strong>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </PanelBody>
  );
}
