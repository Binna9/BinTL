import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import { NavIcon } from "@/components/ui/nav-icons";
import { PanelBody } from "@/components/ui/panel";
import { useLanguage } from "@/i18n/LanguageProvider";
import { useDashboard } from "@/hooks/overview/DashboardContext";
import { sharePercent } from "@/lib/overview";
import type { SummaryScope } from "../types";
import { DashScopeToggle, OpsCard } from "./parts";

function historyTo(scope: SummaryScope, status: "running" | "succeeded" | "failed") {
  const params = new URLSearchParams({ status });
  if (scope === "workspace") params.set("tab", "workspace");
  return `/history?${params}`;
}

export function SummaryScopeToggle() {
  const { messages } = useLanguage();
  const { summaryScope, setSummaryScope } = useDashboard();

  return (
    <DashScopeToggle<SummaryScope>
      value={summaryScope}
      onChange={setSummaryScope}
      label={messages.overview.summaryScope}
      options={[
        { id: "chip", label: messages.overview.summaryChip, icon: <NavIcon name="chips" className="size-3.5" /> },
        { id: "workspace", label: messages.overview.summaryWorkspace, icon: <NavIcon name="workspace" className="size-3.5" /> },
      ]}
    />
  );
}

export function SummaryWidget() {
  const { messages } = useLanguage();
  const { model, summaryScope } = useDashboard();
  const ops = summaryScope === "chip" ? model.chipOps : model.workspaceOps;
  const total = ops.running + ops.succeeded + ops.failed;
  const share = (count: number) => messages.overview.share(sharePercent(count, total));

  return (
    <PanelBody className="flex h-full min-h-0 flex-wrap gap-3">
      <OpsCard
        tone="blue"
        to={historyTo(summaryScope, "running")}
        icon={<LoaderCircle className={`size-3.5 ${ops.running ? "animate-spin" : ""}`} />}
        title={messages.overview.running}
        value={messages.common.cases(ops.running)}
        hint={messages.overview.queuedHint(ops.queued)}
        share={share(ops.running)}
        bar={ops.bar}
      />
      <OpsCard
        tone="green"
        to={historyTo(summaryScope, "succeeded")}
        icon={<CircleCheck className="size-3.5" />}
        title={messages.overview.succeeded}
        value={messages.common.cases(ops.succeeded)}
        hint={messages.overview.succeededHint}
        share={share(ops.succeeded)}
      />
      <OpsCard
        tone="red"
        to={historyTo(summaryScope, "failed")}
        icon={<CircleAlert className="size-3.5" />}
        title={messages.overview.failed}
        value={messages.common.cases(ops.failed)}
        hint={messages.overview.failedHint}
        share={share(ops.failed)}
      />
    </PanelBody>
  );
}
