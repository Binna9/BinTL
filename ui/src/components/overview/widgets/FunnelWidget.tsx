import { type CSSProperties } from "react";
import { ChevronDown, DatabaseZap, FileOutput, ShieldCheck, Terminal, Workflow, type LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { PanelBody } from "@/components/ui/panel";
import { useLanguage } from "@/i18n/LanguageProvider";
import { useDashboard } from "@/hooks/overview/DashboardContext";
import type { ChipKind } from "@/types/chip";

const FLOW: ChipKind[] = ["extract", "transform", "load"];
const EXTRA: ChipKind[] = ["sql", "validation"];

const META: Record<ChipKind, { icon: LucideIcon; tone: string }> = {
  extract: { icon: DatabaseZap, tone: "var(--theme-accent)" },
  transform: { icon: Workflow, tone: "var(--theme-success)" },
  load: { icon: FileOutput, tone: "var(--theme-warning)" },
  sql: { icon: Terminal, tone: "var(--theme-text)" },
  validation: { icon: ShieldCheck, tone: "var(--theme-text-tertiary)" },
};

export function FunnelWidget() {
  const { messages } = useLanguage();
  const { model } = useDashboard();
  const rows: Record<ChipKind, { count: number; rate: number | null }> = {
    extract: { count: model.extractCount, rate: model.extractRate },
    transform: { count: model.transformCount, rate: model.transformRate },
    load: { count: model.loadCount, rate: model.loadRate },
    sql: { count: model.sqlCount, rate: model.sqlRate },
    validation: { count: model.validationCount, rate: model.validationRate },
  };
  const peak = Math.max(1, ...Object.values(rows).map((row) => row.count));

  function label(kind: ChipKind) {
    if (kind === "extract") return messages.overview.extract;
    if (kind === "transform") return messages.overview.transform;
    if (kind === "load") return messages.overview.load;
    if (kind === "sql") return messages.workspace.sql;
    return messages.workspace.validation;
  }

  function stage(kind: ChipKind) {
    const meta = META[kind];
    const Icon = meta.icon;
    const row = rows[kind];
    return (
      <Link
        key={kind}
        to="/history"
        className="dash-flow-row"
        style={{ "--dash-flow-tone": meta.tone } as CSSProperties}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate text-left">{label(kind)}</span>
        <span className="dash-flow-bar" aria-hidden="true">
          <span style={{ width: `${Math.round((row.count / peak) * 100)}%` }} />
        </span>
        <span className="tabular-nums text-text">
          {row.count}
          <span
            className="ml-1.5 font-medium text-text-tertiary"
            title={row.rate == null ? messages.overview.noRate : messages.overview.successRate(row.rate)}
          >
            {row.rate == null ? "—" : `${row.rate}%`}
          </span>
        </span>
      </Link>
    );
  }

  return (
    <PanelBody className="h-full min-h-0">
      <div className="dash-flow">
        {FLOW.map((kind, index) => (
          <div key={kind}>
            {index > 0 ? (
              <div className="dash-flow-arrow" aria-hidden="true">
                <ChevronDown className="size-3" />
              </div>
            ) : null}
            {stage(kind)}
          </div>
        ))}
        <hr className="dash-flow-split" />
        {EXTRA.map((kind) => stage(kind))}
      </div>
    </PanelBody>
  );
}
