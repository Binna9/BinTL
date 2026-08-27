import { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ChevronRight } from "lucide-react";
import { useLanguage } from "@/i18n/LanguageProvider";
import { fmtWhen } from "@/lib/format";
import type { FeedItem } from "../types";

export function OpsCard({
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
  const glow = tone === "blue" ? "#3b8bff" : tone === "green" ? "#34d399" : "#f87171";
  const ink =
    tone === "blue"
      ? "text-[#1769c2] dark:text-[#6aaaef]"
      : tone === "green"
        ? "text-[#287a4b] dark:text-[#5fd0a8]"
        : "text-[#c43835] dark:text-[#ee817d]";

  return (
    <Link
      to={to}
      className="ops-shell relative h-full min-h-0 min-w-[10.5rem] flex-1 overflow-hidden rounded-xl no-underline drop-shadow-xl transition-transform duration-200 hover:z-10 hover:scale-[1.03]"
      style={{ "--ops-glow": glow } as CSSProperties}
    >
      <div className="ops-shell-inner absolute inset-0.5 z-[1] flex flex-col rounded-xl px-3 py-2">
        <span className={`flex items-center gap-1.5 ${ink}`}>
          <span className="grid size-6 shrink-0 place-items-center rounded-full border border-current/30">
            {icon}
          </span>
          <span className="text-[12px] font-semibold tracking-[-0.02em]">{title}</span>
        </span>
        <span className="flex min-h-0 flex-1 flex-col items-center justify-center text-center">
          <span className={`text-[1.55rem] font-semibold leading-none tracking-[-0.04em] tabular-nums ${ink}`}>
            {value}
          </span>
          <span className="mt-1 text-[11px] text-black/45 dark:text-white/55">{hint}</span>
        </span>
        {bar == null ? (
          <span className="h-4" />
        ) : (
          <span>
            <span className="block text-right text-[10px] font-medium tabular-nums text-black/40 dark:text-white/50">
              {bar}%
            </span>
            <span className="mt-0.5 block h-1 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
              <span className="block h-full rounded-full" style={{ width: `${bar}%`, background: glow }} />
            </span>
          </span>
        )}
      </div>
      <div className="ops-shell-glow absolute -left-1/2 -top-1/2 h-48 w-56 blur-[50px]" />
    </Link>
  );
}

export function AssetTile({
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
    <Link to={to} className="asset-tile" style={{ "--asset-accent": accent } as CSSProperties}>
      <span className="flex items-center justify-between gap-2">
        <span
          className="grid size-8 place-items-center rounded-lg"
          style={{
            background: "color-mix(in srgb, var(--asset-accent) 16%, transparent)",
            color: "var(--asset-accent)",
          }}
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

export function FeedRow({
  item,
  extra,
  detail = false,
  showArrow = false,
}: {
  item: FeedItem;
  extra?: ReactNode;
  detail?: boolean;
  showArrow?: boolean;
}) {
  const { messages } = useLanguage();
  return (
    <Link to={item.to} className="dash-feed-row">
      <span className={`dash-kind dash-kind-${item.kind}`}>
        {item.kind === "extract" ? messages.overview.extract : messages.overview.transform}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-text">{item.title}</span>
        {detail ? (
          <span className="mt-0.5 block truncate text-[11px] text-danger">
            {item.error || messages.overview.failedHint}
          </span>
        ) : null}
      </span>
      {extra}
      <span className="shrink-0 text-right text-[11px] tabular-nums text-text-tertiary">
        {fmtWhen(item.at)}
      </span>
      {showArrow ? <ArrowRight className="size-3.5 shrink-0 text-text-tertiary" /> : null}
    </Link>
  );
}
