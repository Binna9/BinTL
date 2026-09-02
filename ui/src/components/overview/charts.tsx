import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArcElement,
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
  type Plugin,
  type ScriptableContext,
} from "chart.js";
import { Bar, Doughnut, Line } from "react-chartjs-2";
import { useLanguage } from "@/i18n/LanguageProvider";
import type { DayPoint } from "@/lib/overview";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
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

export function TrendChart({ days }: { days: DayPoint[] }) {
  const { messages } = useLanguage();
  const palette = useChartPalette();

  const data = useMemo<ChartData<"line">>(
    () => ({
      labels: days.map((day) => day.label),
      datasets: [
        {
          label: messages.overview.extract,
          data: days.map((day) => day.extract),
          borderColor: palette.accent,
          backgroundColor: (ctx) => lineFill(ctx, palette.accent, 0.28, 0.02),
          borderWidth: 2.4,
          tension: 0.38,
          fill: true,
          pointRadius: 3.2,
          pointHoverRadius: 5.5,
          pointBackgroundColor: palette.surface,
          pointBorderColor: palette.accent,
          pointBorderWidth: 2,
          pointHoverBorderWidth: 2.4,
        },
        {
          label: messages.overview.transform,
          data: days.map((day) => day.transform),
          borderColor: palette.success,
          backgroundColor: (ctx) => lineFill(ctx, palette.success, 0.22, 0.02),
          borderWidth: 2.4,
          tension: 0.38,
          fill: true,
          pointRadius: 3.2,
          pointHoverRadius: 5.5,
          pointBackgroundColor: palette.surface,
          pointBorderColor: palette.success,
          pointBorderWidth: 2,
          pointHoverBorderWidth: 2.4,
        },
        {
          label: messages.overview.load,
          data: days.map((day) => day.load),
          borderColor: palette.warning,
          backgroundColor: (ctx) => lineFill(ctx, palette.warning, 0.18, 0.02),
          borderWidth: 2.2,
          borderDash: [5, 4],
          tension: 0.38,
          fill: false,
          pointRadius: 2.6,
          pointHoverRadius: 5,
          pointBackgroundColor: palette.surface,
          pointBorderColor: palette.warning,
          pointBorderWidth: 2,
        },
      ],
    }),
    [days, messages, palette],
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

type CenterOpts = { label?: string; total?: number };

const doughnutCenter: Plugin<"doughnut"> = {
  id: "doughnutCenter",
  afterDraw(chart) {
    const meta = chart.getDatasetMeta(0);
    if (!meta?.data?.[0]) return;
    const plugins = chart.options.plugins as Record<string, CenterOpts | undefined> | undefined;
    const opts = plugins?.doughnutCenter;
    const values = (chart.data.datasets[0]?.data ?? []) as number[];
    const total = opts?.total ?? values.reduce((sum, value) => sum + Number(value || 0), 0);
    const { x, y } = meta.data[0];
    const { ctx } = chart;
    const label = opts?.label ?? "";
    const ink = getComputedStyle(document.documentElement).getPropertyValue("--theme-text").trim() || "#20242a";
    const muted = getComputedStyle(document.documentElement).getPropertyValue("--theme-text-tertiary").trim()
      || "#89919c";
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = ink;
    ctx.font = "700 1.35rem Pretendard Variable, Pretendard, sans-serif";
    ctx.fillText(String(total), x, y - (label ? 8 : 0));
    if (label) {
      ctx.fillStyle = muted;
      ctx.font = "600 0.68rem Pretendard Variable, Pretendard, sans-serif";
      ctx.fillText(label, x, y + 14);
    }
    ctx.restore();
  },
};

export function FlowChart({
  stages,
}: {
  stages: Array<{ name: string; value: number; to: string }>;
}) {
  const { messages } = useLanguage();
  const navigate = useNavigate();
  const palette = useChartPalette();
  const colors = useMemo(
    () => [palette.accent, palette.success, palette.warning],
    [palette.accent, palette.success, palette.warning],
  );
  const hasData = stages.some((stage) => stage.value > 0);
  const realTotal = stages.reduce((sum, stage) => sum + stage.value, 0);
  const unit = messages.common.cases(0).replace(/\d+/g, "").trim() || "건";

  const data = useMemo<ChartData<"doughnut">>(
    () => ({
      labels: stages.map((stage) => stage.name),
      datasets: [
        {
          data: hasData ? stages.map((stage) => stage.value) : [1],
          backgroundColor: hasData
            ? colors.map((color) => alpha(color, 0.9))
            : [alpha(palette.grid, 0.55)],
          borderColor: palette.surface,
          borderWidth: 3,
          hoverOffset: 8,
          hoverBorderWidth: 3,
        },
      ],
    }),
    [colors, hasData, palette.grid, palette.surface, stages],
  );

  const options = useMemo<ChartOptions<"doughnut">>(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      cutout: "68%",
      animation: { animateRotate: true, duration: 900, easing: "easeOutQuart" },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...chartTooltip(),
          enabled: hasData,
          callbacks: {
            label(item) {
              return ` ${messages.common.cases(Number(item.raw ?? 0))}`;
            },
          },
        },
        doughnutCenter: { label: unit, total: realTotal },
      } as ChartOptions<"doughnut">["plugins"],
      onClick(_event, elements) {
        if (!hasData) return;
        const index = elements[0]?.index;
        if (index == null) return;
        const target = stages[index]?.to;
        if (target) navigate(target);
      },
      onHover(event, elements) {
        const canvas = event.native?.target as HTMLCanvasElement | undefined;
        if (canvas) canvas.style.cursor = hasData && elements.length ? "pointer" : "default";
      },
    }),
    [hasData, messages, navigate, realTotal, stages, unit],
  );

  return (
    <div className="flex h-full min-h-0 items-center gap-3">
      <div className="relative h-full min-h-0 min-w-0 flex-1">
        <Doughnut data={data} options={options} plugins={[doughnutCenter]} />
      </div>
      <ul className="dash-chart-legend shrink-0 space-y-2.5 pr-1">
        {stages.map((stage, index) => (
          <li key={stage.to}>
            <button
              type="button"
              className="dash-chart-legend-item"
              onClick={() => navigate(stage.to)}
            >
              <i style={{ background: colors[index] ?? palette.accent }} />
              <span className="min-w-0 flex-1 truncate text-left">{stage.name}</span>
              <strong>{stage.value}</strong>
            </button>
          </li>
        ))}
      </ul>
    </div>
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
