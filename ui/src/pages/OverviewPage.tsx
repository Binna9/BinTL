import { CSSProperties, ReactNode, useId, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  Boxes,
  Cable,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Database,
  FolderOpen,
  GitBranch,
  ListChecks,
  LoaderCircle,
  Sparkles,
  Upload,
} from "lucide-react";
import { PageHeader, PageShell } from "@/components/PageShell";
import { StatusPill } from "@/components/StatusPill";
import { LiveDot } from "@/components/ui/live-dot";
import { PanelBody, PanelHeader } from "@/components/ui/panel";
import { useOverviewData } from "@/hooks/useOverviewData";
import { useLanguage } from "@/i18n/LanguageProvider";
import { fmtWhen } from "@/lib/format";
import { bucketActivity, fileName, successRate, type DayPoint } from "@/lib/overview";
import type { ExtractRecord } from "@/types/extract";
import type { EtlJob } from "@/types/job";

const chrome =
  "rounded-xl bg-surface shadow-[0_1px_3px_rgba(15,23,42,0.045)] dark:border dark:border-white/15 dark:shadow-[0_2px_8px_rgba(0,0,0,0.16)]";
const rail = "flex min-w-[18rem] flex-col xl:w-[22rem] xl:shrink-0";

function countStatus(rows: { status: string }[], status: string) {
  return rows.filter((row) => row.status === status).length;
}

function OpsCard({
  tone,
  to,
  icon,
  title,
  value,
  hint,
  bar,
}: {
  tone: "blue" | "green" | "red";
  to: string;
  icon: ReactNode;
  title: string;
  value: string;
  hint: string;
  bar?: number;
}) {
  const glow =
    tone === "blue" ? "#3b8bff" : tone === "green" ? "#34d399" : "#f87171";
  const ink =
    tone === "blue"
      ? "text-[#1769c2] dark:text-[#6aaaef]"
      : tone === "green"
        ? "text-[#287a4b] dark:text-[#5fd0a8]"
        : "text-[#c43835] dark:text-[#ee817d]";

  return (
    <Link
      to={to}
      className="ops-shell relative h-44 w-72 overflow-hidden rounded-xl no-underline drop-shadow-xl transition-transform duration-200 hover:z-10 hover:scale-[1.04]"
      style={{ "--ops-glow": glow } as CSSProperties}
    >
      <div className="ops-shell-inner absolute inset-0.5 z-[1] flex flex-col rounded-xl px-3.5 py-3">
        <span className={`flex items-center gap-1.5 ${ink}`}>
          <span className="grid size-7 shrink-0 place-items-center rounded-full border border-current/30">
            {icon}
          </span>
          <span className="text-[13px] font-semibold tracking-[-0.02em]">{title}</span>
        </span>
        <span className="flex min-h-0 flex-1 flex-col items-center justify-center text-center">
          <span className={`text-[2rem] font-semibold leading-none tracking-[-0.04em] tabular-nums ${ink}`}>
            {value}
          </span>
          <span className="mt-1.5 text-[12px] text-black/45 dark:text-white/55">{hint}</span>
        </span>
        {bar == null ? (
          <span className="h-6" />
        ) : (
          <span>
            <span className="block text-right text-[11px] font-medium tabular-nums text-black/40 dark:text-white/50">
              {bar}%
            </span>
            <span className="mt-1 block h-1 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
              <span
                className="block h-full rounded-full"
                style={{ width: `${bar}%`, background: glow }}
              />
            </span>
          </span>
        )}
      </div>
      <div className="ops-shell-glow absolute -left-1/2 -top-1/2 h-48 w-56 blur-[50px]" />
    </Link>
  );
}

function AssetTile({
  to,
  accent,
  icon,
  label,
  value,
  hint,
}: {
  to: string;
  accent: string;
  icon: ReactNode;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Link
      to={to}
      className="asset-tile"
      style={{ "--asset-accent": accent } as CSSProperties}
    >
      <span className="flex items-center justify-between gap-2">
        <span
          className="grid size-8 place-items-center rounded-lg"
          style={{ background: "color-mix(in srgb, var(--asset-accent) 16%, transparent)", color: "var(--asset-accent)" }}
        >
          {icon}
        </span>
        <ChevronRight className="size-3.5 text-text-tertiary" />
      </span>
      <span>
        <span className="block text-[1.45rem] font-semibold leading-none tracking-[-0.04em] tabular-nums">
          {value}
        </span>
        <span className="mt-1.5 block text-[12px] font-semibold tracking-[-0.02em]">{label}</span>
        <span className="mt-0.5 block text-[11px] text-text-secondary">{hint}</span>
      </span>
    </Link>
  );
}

function TrendChart({ days }: { days: DayPoint[] }) {
  const uid = useId().replace(/:/g, "");
  const w = 560;
  const h = 148;
  const padX = 10;
  const padTop = 10;
  const padBot = 6;
  const innerW = w - padX * 2;
  const innerH = h - padTop - padBot;
  const totals = days.map((d) => d.extract + d.transform + d.load);
  const max = Math.max(1, ...totals);
  const x = (i: number) =>
    padX + (days.length <= 1 ? innerW / 2 : (i / (days.length - 1)) * innerW);
  const y = (v: number) => padTop + innerH - (v / max) * innerH;
  const area = `M ${x(0).toFixed(1)} ${(padTop + innerH).toFixed(1)} ${days
    .map((d, i) => `L ${x(i).toFixed(1)} ${y(d.extract + d.transform).toFixed(1)}`)
    .join(" ")} L ${x(days.length - 1).toFixed(1)} ${(padTop + innerH).toFixed(1)} Z`;
  const line = days
    .map((d, i) => `${x(i).toFixed(1)},${y(d.extract + d.transform).toFixed(1)}`)
    .join(" ");

  return (
    <div className="dash-chart">
      <svg viewBox={`0 0 ${w} ${h}`} className="dash-chart-area" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={`g-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((t) => (
          <line
            key={t}
            x1={padX}
            x2={w - padX}
            y1={padTop + innerH * t}
            y2={padTop + innerH * t}
            className="dash-chart-grid"
          />
        ))}
        <path d={area} fill={`url(#g-${uid})`} />
        <polyline points={line} fill="none" className="dash-chart-line" />
      </svg>
      <div className="relative z-[1] flex h-36 items-end gap-2 px-1">
        {days.map((day) => {
          const total = day.extract + day.transform + day.load;
          const height = total ? Math.max(10, (total / max) * 100) : 3;
          return (
            <div key={day.key} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
              <div className="flex h-28 w-full max-w-11 items-end justify-center">
                <div
                  className="flex w-[70%] min-w-3.5 flex-col-reverse overflow-hidden rounded-md bg-subtle"
                  style={{ height: `${height}%` }}
                  title={`${day.label}: ${total}`}
                >
                  {day.extract ? (
                    <span className="bg-accent" style={{ height: `${(day.extract / Math.max(total, 1)) * 100}%` }} />
                  ) : null}
                  {day.transform ? (
                    <span className="bg-success" style={{ height: `${(day.transform / Math.max(total, 1)) * 100}%` }} />
                  ) : null}
                  {day.load ? (
                    <span className="bg-warning" style={{ height: `${(day.load / Math.max(total, 1)) * 100}%` }} />
                  ) : null}
                </div>
              </div>
              <span className="text-[10px] tabular-nums text-text-tertiary">{day.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FunnelStage({
  to,
  label,
  meta,
  tone,
  fill,
}: {
  to: string;
  label: string;
  meta: string;
  tone: "accent" | "success" | "warning";
  fill: number;
}) {
  return (
    <Link to={to} className="dash-funnel-stage">
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] font-semibold text-text">{label}</span>
        <span className="text-[11px] tabular-nums text-text-secondary">{meta}</span>
      </span>
      <span className="dash-funnel-track">
        <span className={`dash-funnel-fill dash-funnel-fill-${tone}`} style={{ width: `${fill}%` }} />
      </span>
    </Link>
  );
}

type FeedItem = {
  id: string;
  kind: "extract" | "transform";
  title: string;
  status: string;
  at: string;
  to: string;
  error: string | null;
};

function toFeed(extracts: ExtractRecord[], jobs: EtlJob[]): FeedItem[] {
  return [
    ...extracts.map((row) => ({
      id: row.id,
      kind: "extract" as const,
      title: row.table_name || row.filename || row.id.slice(0, 8),
      status: row.status,
      at: row.created_at,
      to: "/extracts",
      error: row.error_message,
    })),
    ...jobs.map((row) => ({
      id: row.id,
      kind: "transform" as const,
      title: fileName(row.source_path) || row.id.slice(0, 8),
      status: row.status,
      at: row.created_at,
      to: `/jobs/${row.id}`,
      error: row.error_message,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
}

export function OverviewPage() {
  const { messages } = useLanguage();
  const {
    systemHealth,
    recentJobs,
    recentExtracts,
    workspaceCount,
    activeTaskCount,
    datasetCount,
    connectionCount,
  } = useOverviewData();
  const work = [...recentJobs, ...recentExtracts];
  const running = countStatus(work, "running");
  const queued = countStatus(work, "queued");
  const succeeded = countStatus(work, "succeeded");
  const failed = countStatus(work, "failed");
  const active = running + queued;
  const bar = active ? Math.round((running / active) * 100) : 0;
  const days = useMemo(
    () => bucketActivity(recentExtracts, recentJobs),
    [recentExtracts, recentJobs],
  );
  const feed = useMemo(() => toFeed(recentExtracts, recentJobs), [recentExtracts, recentJobs]);
  const attention = feed.filter((item) => item.status === "failed").slice(0, 5);
  const extractRate = successRate(recentExtracts);
  const transformRate = successRate(recentJobs);
  const funnelMax = Math.max(recentExtracts.length, recentJobs.length, 1);

  return (
    <PageShell>
      <PageHeader
        iconName="overview"
        eyebrow={messages.overview.eyebrow}
        title={messages.overview.title}
        description={messages.overview.description}
        actions={
          systemHealth ? (
            <LiveDot
              label={`${systemHealth.ok ? messages.overview.healthy : messages.overview.down} · v${systemHealth.version}`}
            />
          ) : null
        }
      />

      <div className="flex flex-col gap-3 xl:flex-row">
        <section className={`min-w-0 flex-1 ${chrome}`}>
          <PanelHeader
            icon={<Activity className="size-3.5" aria-hidden="true" />}
            title={messages.overview.summary}
            description={messages.overview.summaryDescription}
          />
          <PanelBody className="flex flex-wrap gap-4">
            <OpsCard
              tone="blue"
              to="/history"
              icon={<LoaderCircle className={`size-3.5 ${running ? "animate-spin" : ""}`} />}
              title={messages.overview.running}
              value={messages.common.cases(running)}
              hint={messages.overview.queuedHint(queued)}
              bar={bar}
            />
            <OpsCard
              tone="green"
              to="/history"
              icon={<CircleCheck className="size-3.5" />}
              title={messages.overview.succeeded}
              value={messages.common.cases(succeeded)}
              hint={messages.overview.succeededHint}
            />
            <OpsCard
              tone="red"
              to="/history"
              icon={<CircleAlert className="size-3.5" />}
              title={messages.overview.failed}
              value={messages.common.cases(failed)}
              hint={messages.overview.failedHint}
            />
          </PanelBody>
        </section>
        <section className={`${rail} ${chrome}`}>
          <PanelHeader
            icon={<Boxes className="size-3.5" aria-hidden="true" />}
            title={messages.overview.assets}
            description={messages.overview.assetsDescription}
          />
          <PanelBody className="grid min-h-44 flex-1 grid-cols-2 grid-rows-2 gap-3">
            <AssetTile
              to="/workspace"
              accent="#1769c2"
              icon={<FolderOpen className="size-3.5" />}
              label={messages.overview.workspaces}
              value={messages.common.count(workspaceCount)}
              hint={messages.overview.workspacesHint}
            />
            <AssetTile
              to="/workspace"
              accent="#287a4b"
              icon={<ListChecks className="size-3.5" />}
              label={messages.overview.activeTasks}
              value={messages.common.count(activeTaskCount)}
              hint={messages.overview.activeTasksHint}
            />
            <AssetTile
              to="/transform"
              accent="#9a6700"
              icon={<Database className="size-3.5" />}
              label={messages.overview.datasets}
              value={messages.common.count(datasetCount)}
              hint={messages.overview.datasetsHint}
            />
            <AssetTile
              to="/connections"
              accent="#c43835"
              icon={<Cable className="size-3.5" />}
              label={messages.overview.connectionsAsset}
              value={messages.common.count(connectionCount)}
              hint={messages.overview.connectionsHint}
            />
          </PanelBody>
        </section>
      </div>

      <div className="flex flex-col gap-3 xl:flex-row">
        <section className={`min-w-0 flex-1 ${chrome}`}>
          <PanelHeader
            icon={<Activity className="size-3.5" aria-hidden="true" />}
            title={messages.overview.trend}
            description={messages.overview.trendDescription}
            actions={
              <span className="dash-legend">
                <span><i className="bg-accent" />{messages.overview.extract}</span>
                <span><i className="bg-success" />{messages.overview.transform}</span>
                <span><i className="bg-warning" />{messages.overview.load}</span>
              </span>
            }
          />
          <PanelBody>
            <TrendChart days={days} />
          </PanelBody>
        </section>
        <section className={`${rail} ${chrome}`}>
          <PanelHeader
            icon={<GitBranch className="size-3.5" aria-hidden="true" />}
            title={messages.overview.funnel}
            description={messages.overview.funnelDescription}
          />
          <PanelBody className="flex flex-1 flex-col justify-center gap-5">
            <FunnelStage
              to="/extracts"
              label={messages.overview.extract}
              meta={
                extractRate == null
                  ? `${messages.common.cases(recentExtracts.length)} · ${messages.overview.noRate}`
                  : `${messages.common.cases(recentExtracts.length)} · ${messages.overview.successRate(extractRate)}`
              }
              tone="accent"
              fill={recentExtracts.length ? Math.max(18, (recentExtracts.length / funnelMax) * 100) : 0}
            />
            <FunnelStage
              to="/transform"
              label={messages.overview.transform}
              meta={
                transformRate == null
                  ? `${messages.common.cases(recentJobs.length)} · ${messages.overview.noRate}`
                  : `${messages.common.cases(recentJobs.length)} · ${messages.overview.successRate(transformRate)}`
              }
              tone="success"
              fill={recentJobs.length ? Math.max(18, (recentJobs.length / funnelMax) * 100) : 0}
            />
            <FunnelStage
              to="/load"
              label={messages.overview.load}
              meta={messages.common.comingSoon}
              tone="warning"
              fill={0}
            />
          </PanelBody>
        </section>
      </div>

      <div className="flex flex-col gap-3 xl:flex-row">
        <section className={`min-w-0 flex-1 ${chrome}`}>
          <PanelHeader
            icon={<CircleAlert className="size-3.5" aria-hidden="true" />}
            title={messages.overview.attention}
            description={messages.overview.attentionDescription}
          />
          {attention.length === 0 ? (
            <PanelBody>
              <p className="flex items-center gap-2 text-sm text-success">
                <CircleCheck className="size-4" />
                {messages.overview.attentionEmpty}
              </p>
            </PanelBody>
          ) : (
            <ul className="divide-y divide-border">
              {attention.map((item) => (
                <li key={`${item.kind}-${item.id}`}>
                  <Link to={item.to} className="dash-feed-row">
                    <span className={`dash-kind dash-kind-${item.kind}`}>
                      {item.kind === "extract" ? messages.overview.extract : messages.overview.transform}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-text">{item.title}</span>
                      <span className="mt-0.5 block truncate text-[11px] text-danger">
                        {item.error || messages.overview.failedHint}
                      </span>
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-text-tertiary">{fmtWhen(item.at)}</span>
                    <ArrowRight className="size-3.5 shrink-0 text-text-tertiary" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className={`${rail} ${chrome}`}>
          <PanelHeader
            icon={<Sparkles className="size-3.5" aria-hidden="true" />}
            title={messages.overview.start}
            description={messages.overview.startDescription}
          />
          <PanelBody className="flex flex-col gap-2.5">
            <Link to="/files" className="dash-start">
              <span className="dash-start-icon">
                <Upload className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-text">{messages.overview.startUpload}</span>
                <span className="mt-0.5 block text-[11px] text-text-secondary">{messages.overview.startUploadHint}</span>
              </span>
              <ChevronRight className="size-4 text-text-tertiary" />
            </Link>
            <Link to="/workspace" className="dash-start">
              <span className="dash-start-icon">
                <FolderOpen className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-text">{messages.overview.startWorkspace}</span>
                <span className="mt-0.5 block text-[11px] text-text-secondary">{messages.overview.startWorkspaceHint}</span>
              </span>
              <ChevronRight className="size-4 text-text-tertiary" />
            </Link>
            <Link to="/connections" className="dash-start">
              <span className="dash-start-icon">
                <Cable className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-text">{messages.overview.startConnection}</span>
                <span className="mt-0.5 block text-[11px] text-text-secondary">{messages.overview.startConnectionHint}</span>
              </span>
              <ChevronRight className="size-4 text-text-tertiary" />
            </Link>
          </PanelBody>
        </section>
      </div>

      <section className={chrome}>
        <PanelHeader
          icon={<ListChecks className="size-3.5" aria-hidden="true" />}
          title={messages.overview.activity}
          description={messages.overview.activityDescription}
        />
        {feed.length === 0 ? (
          <PanelBody>
            <p className="text-sm text-text-secondary">{messages.overview.activityEmpty}</p>
          </PanelBody>
        ) : (
          <ul className="divide-y divide-border">
            {feed.slice(0, 8).map((item) => (
              <li key={`${item.kind}-${item.id}`}>
                <Link to={item.to} className="dash-feed-row">
                  <span className={`dash-kind dash-kind-${item.kind}`}>
                    {item.kind === "extract" ? messages.overview.extract : messages.overview.transform}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text">{item.title}</span>
                  <StatusPill value={item.status} />
                  <span className="w-[9.5rem] shrink-0 text-right text-[11px] tabular-nums text-text-tertiary">
                    {fmtWhen(item.at)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PageShell>
  );
}
