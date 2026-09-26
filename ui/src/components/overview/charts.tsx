import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
  type ChartData,
  type ChartOptions,
  type ScriptableContext,
} from "chart.js";
import { Bar, Line } from "react-chartjs-2";
import { useLanguage } from "@/i18n/LanguageProvider";
import type { DayPoint } from "@/lib/overview";
import type { ChipKind } from "@/types/chip";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
  Filler,
);

type Palette = {
  accent: string;
  success: string;
  warning: string;
  danger: string;
  text: string;
  muted: string;
  grid: string;
  surface: string;
  ink: string;
};

const FALLBACK: Palette = {
  accent: "#1769c2",
  success: "#287a4b",
  warning: "#9a6700",
  danger: "#c43835",
  text: "#5d6672",
  muted: "#89919c",
  grid: "#d8dde3",
  surface: "#ffffff",
  ink: "#20242a",
};

function alpha(hex: string, opacity: number) {
  const raw = hex.replace("#", "").trim();
  if (raw.length !== 6) return hex;
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

function useChartPalette(): Palette {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setTick((value) => value + 1);
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return useMemo(() => {
    const styles = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    return {
      accent: read("--theme-accent", FALLBACK.accent),
      success: read("--theme-success", FALLBACK.success),
      warning: read("--theme-warning", FALLBACK.warning),
      danger: read("--theme-danger", FALLBACK.danger),
      text: read("--theme-text-secondary", FALLBACK.text),
      muted: read("--theme-text-tertiary", FALLBACK.muted),
      grid: read("--theme-border", FALLBACK.grid),
      surface: read("--theme-surface", FALLBACK.surface),
      ink: read("--theme-text", FALLBACK.ink),
    };
  }, [tick]);
}

/** Always light card + dark type so dark-mode hover stays readable. */
function chartTooltip() {
  return {
    backgroundColor: "#ffffff",
    titleColor: "#20242a",
    bodyColor: "#3a4250",
    footerColor: "#5d6672",
    borderColor: "rgba(32, 36, 42, 0.12)",
    borderWidth: 1,
    cornerRadius: 10,
    padding: 10,
    displayColors: true,
    boxPadding: 4,
  };
}

function ChartFrame({ children }: { children: React.ReactNode }) {
  return <div className="dash-chart h-full min-h-0 w-full">{children}</div>;
}

function lineFill(
  ctx: ScriptableContext<"line">,
  color: string,
  top: number,
  bottom: number,
) {
  const { ctx: canvas, chartArea } = ctx.chart;
  if (!chartArea) return alpha(color, 0.12);
  const gradient = canvas.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  gradient.addColorStop(0, alpha(color, top));
  gradient.addColorStop(1, alpha(color, bottom));
  return gradient;
}

export function TrendChart({ days, hidden = [] }: { days: DayPoint[]; hidden?: ChipKind[] }) {
  const { messages } = useLanguage();
  const palette = useChartPalette();

  const data = useMemo<ChartData<"line">>(
    () => ({
      labels: days.map((day) => day.label),
      datasets: (
        [
          {
            kind: "extract",
            label: messages.overview.extract,
            values: days.map((day) => day.extract),
            color: palette.accent,
            fillTop: 0.28,
            dash: undefined,
            fill: true,
            point: 3.2,
          },
          {
            kind: "transform",
            label: messages.overview.transform,
            values: days.map((day) => day.transform),
            color: palette.success,
            fillTop: 0.22,
            dash: undefined,
            fill: true,
            point: 3.2,
          },
          {
            kind: "load",
            label: messages.overview.load,
            values: days.map((day) => day.load),
            color: palette.warning,
            fillTop: 0.18,
            dash: [5, 4] as number[],
            fill: false,
            point: 2.6,
          },
          {
            kind: "sql",
            label: messages.workspace.sql,
            values: days.map((day) => day.sql),
            color: palette.ink,
            fillTop: 0.16,
            dash: undefined,
            fill: false,
            point: 2.6,
          },
          {
            kind: "script",
            label: messages.overview.script,
            values: days.map((day) => day.script),
            color: "#d97706",
            fillTop: 0.18,
            dash: undefined,
            fill: false,
            point: 2.6,
          },
          {
            kind: "serve",
            label: messages.workspace.serve,
            values: days.map((day) => day.serve),
            color: "#14b8a6",
            fillTop: 0.2,
            dash: undefined,
            fill: true,
            point: 2.6,
          },
          {
            kind: "validation",
            label: messages.workspace.validation,
            values: days.map((day) => day.validation),
            color: palette.muted,
            fillTop: 0.12,
            dash: [4, 4] as number[],
            fill: false,
            point: 2.4,
          },
        ] satisfies Array<{
          kind: ChipKind;
          label: string;
          values: number[];
          color: string;
          fillTop: number;
          dash?: number[];
          fill: boolean;
          point: number;
        }>
      )
        .filter((series) => !hidden.includes(series.kind))
        .map((series) => ({
          label: series.label,
          data: series.values,
          borderColor: series.color,
          backgroundColor: (ctx: ScriptableContext<"line">) => lineFill(ctx, series.color, series.fillTop, 0.02),
          borderWidth: 2.2,
          borderDash: series.dash,
          tension: 0.38,
          fill: series.fill,
          pointRadius: series.point,
          pointHoverRadius: 5.2,
          pointBackgroundColor: palette.surface,
          pointBorderColor: series.color,
          pointBorderWidth: 2,
        })),
    }),
    [days, hidden, messages, palette],
  );

  const options = useMemo<ChartOptions<"line">>(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      animation: { duration: 780, easing: "easeOutQuart" },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...chartTooltip(),
          callbacks: {
            footer(items) {
              const total = items.reduce((sum, item) => sum + Number(item.raw ?? 0), 0);
              return `Σ ${total}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: { color: palette.muted, font: { size: 11, weight: 500 } },
        },
        y: {
          beginAtZero: true,
          grace: "8%",
          ticks: {
            color: palette.muted,
            font: { size: 11 },
            precision: 0,
            maxTicksLimit: 5,
          },
          grid: {
            color: alpha(palette.grid, 0.7),
            tickLength: 0,
          },
          border: { display: false, dash: [4, 4] },
        },
      },
    }),
    [palette],
  );

  return (
    <ChartFrame>
      <Line data={data} options={options} />
    </ChartFrame>
  );
}

export function AssetsChart({
  items,
  totalLabel,
}: {
  items: Array<{ label: string; value: number; accent: string; to: string }>;
  totalLabel: string;
}) {
  const navigate = useNavigate();
  const palette = useChartPalette();
  const total = items.reduce((sum, item) => sum + item.value, 0);

  const data = useMemo<ChartData<"bar">>(
    () => ({
      labels: items.map((item) => item.label),
      datasets: [
        {
          data: items.map((item) => item.value),
          backgroundColor: items.map((item) => alpha(item.accent, 0.88)),
          hoverBackgroundColor: items.map((item) => item.accent),
          borderRadius: 8,
          borderSkipped: false,
          barThickness: 18,
          maxBarThickness: 22,
        },
      ],
    }),
    [items],
  );

  const options = useMemo<ChartOptions<"bar">>(
    () => ({
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 760, easing: "easeOutQuart" },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...chartTooltip(),
          callbacks: {
            label(item) {
              return ` ${item.raw}`;
            },
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          grace: "10%",
          ticks: {
            color: palette.muted,
            font: { size: 10 },
            precision: 0,
            maxTicksLimit: 4,
          },
          grid: {
            color: alpha(palette.grid, 0.65),
            tickLength: 0,
          },
          border: { display: false },
        },
        y: {
          grid: { display: false },
          border: { display: false },
          ticks: {
            color: palette.text,
            font: { size: 11, weight: 600 },
          },
        },
      },
      onClick(_event, elements) {
        const index = elements[0]?.index;
        if (index == null) return;
        const target = items[index]?.to;
        if (target) navigate(target);
      },
      onHover(event, elements) {
        const canvas = event.native?.target as HTMLCanvasElement | undefined;
        if (canvas) canvas.style.cursor = elements.length ? "pointer" : "default";
      },
    }),
    [items, navigate, palette],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2 px-0.5">
        <span className="text-[11px] font-medium text-text-tertiary">{totalLabel}</span>
        <span className="text-[1.15rem] font-semibold tabular-nums tracking-[-0.03em] text-text">
          {total}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <Bar data={data} options={options} />
      </div>
    </div>
  );
}
