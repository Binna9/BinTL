import { useMemo, useState, type CSSProperties } from "react";
import { DatabaseZap, FileOutput, Globe, RotateCcw, ShieldCheck, Terminal, Workflow, type LucideIcon } from "lucide-react";
import { PanelBody } from "@/components/ui/panel";
import { useLanguage } from "@/i18n/LanguageProvider";
import { useDashboard } from "@/hooks/overview/DashboardContext";
import { bucketActivity, clampTrendRange, dayKey, parseDay, shiftDay, TREND_MAX_SPAN_DAYS } from "@/lib/overview";
import type { ChipKind } from "@/types/chip";
import { TrendChart } from "../charts";

const SERIES: { id: ChipKind; icon: LucideIcon; tone: string }[] = [
  { id: "extract", icon: DatabaseZap, tone: "var(--theme-accent)" },
  { id: "transform", icon: Workflow, tone: "var(--theme-success)" },
  { id: "load", icon: FileOutput, tone: "var(--theme-warning)" },
  { id: "sql", icon: Terminal, tone: "var(--theme-text)" },
  { id: "serve", icon: Globe, tone: "#14b8a6" },
  { id: "validation", icon: ShieldCheck, tone: "var(--theme-text-tertiary)" },
];

function todayKey() {
  return dayKey(new Date());
}

function weekAgoKey() {
  const day = new Date();
  day.setDate(day.getDate() - 6);
  return dayKey(day);
}

function seriesLabel(id: ChipKind, messages: ReturnType<typeof useLanguage>["messages"]) {
  if (id === "extract") return messages.overview.extract;
  if (id === "transform") return messages.overview.transform;
  if (id === "load") return messages.overview.load;
  if (id === "sql") return messages.workspace.sql;
  if (id === "serve") return messages.workspace.serve;
  return messages.workspace.validation;
}

export function TrendWidget() {
  const { messages } = useLanguage();
  const { model } = useDashboard();
  const [from, setFrom] = useState(weekAgoKey);
  const [to, setTo] = useState(todayKey);
  const [hidden, setHidden] = useState<ChipKind[]>([]);
  const today = todayKey();
  const toMax = shiftDay(from, TREND_MAX_SPAN_DAYS) > today ? today : shiftDay(from, TREND_MAX_SPAN_DAYS);
  const atDefault = from === weekAgoKey() && to === today && hidden.length === 0;

  const days = useMemo(
    () => bucketActivity(model.trendRuns, { from: parseDay(from), to: parseDay(to) }),
    [from, model.trendRuns, to],
  );

  function setRange(nextFrom: string, nextTo: string) {
    const next = clampTrendRange(nextFrom, nextTo, today);
    setFrom(next.from);
    setTo(next.to);
  }

  function resetRange() {
    setFrom(weekAgoKey());
    setTo(todayKey());
    setHidden([]);
  }

  return (
    <PanelBody className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="dash-trend-range" title={messages.overview.trendMaxRange}>
          <input
            type="date"
            className="field-control"
            aria-label={messages.overview.trendFrom}
            min={shiftDay(to, -TREND_MAX_SPAN_DAYS)}
            max={to}
            value={from}
            onChange={(event) => event.target.value && setRange(event.target.value, to)}
          />
          <span aria-hidden="true">–</span>
          <input
            type="date"
            className="field-control"
            aria-label={messages.overview.trendTo}
            min={from}
            max={toMax}
            value={to}
            onChange={(event) => event.target.value && setRange(from, event.target.value)}
          />
          <button
            type="button"
            className="dash-trend-reset"
            disabled={atDefault}
            aria-label={messages.overview.trendReset}
            title={messages.overview.trendReset}
            onClick={resetRange}
          >
            <RotateCcw className="size-3.5" />
            {messages.overview.trendReset}
          </button>
        </div>
        <div role="group" aria-label={messages.overview.trendSeries} className="dash-trend-keys">
          {SERIES.map((series) => {
            const on = !hidden.includes(series.id);
            const Icon = series.icon;
            return (
              <button
                key={series.id}
                type="button"
                className="dash-trend-key"
                style={{ "--dash-trend-tone": series.tone } as CSSProperties}
                aria-pressed={on}
                aria-label={seriesLabel(series.id, messages)}
                title={seriesLabel(series.id, messages)}
                onClick={() =>
                  setHidden((prev) =>
                    prev.includes(series.id) ? prev.filter((id) => id !== series.id) : [...prev, series.id],
                  )
                }
              >
                <span className="dash-trend-key-icon">
                  <Icon className="size-3.5" />
                  <i className="dash-trend-key-mark" />
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <TrendChart days={days} hidden={hidden} />
      </div>
    </PanelBody>
  );
}
