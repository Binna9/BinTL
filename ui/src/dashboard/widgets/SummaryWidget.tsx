import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import { PanelBody } from "@/components/ui/panel";
import { useLanguage } from "@/i18n/LanguageProvider";
import { useDashboard } from "../DashboardContext";
import { OpsCard } from "./parts";

export function SummaryWidget() {
  const { messages } = useLanguage();
  const { model } = useDashboard();

  return (
    <PanelBody className="flex h-full min-h-0 flex-wrap gap-3">
      <OpsCard
        tone="blue"
        to="/history"
        icon={<LoaderCircle className={`size-3.5 ${model.running ? "animate-spin" : ""}`} />}
        title={messages.overview.running}
        value={messages.common.cases(model.running)}
        hint={messages.overview.queuedHint(model.queued)}
        bar={model.bar}
      />
      <OpsCard
        tone="green"
        to="/history"
        icon={<CircleCheck className="size-3.5" />}
        title={messages.overview.succeeded}
        value={messages.common.cases(model.succeeded)}
        hint={messages.overview.succeededHint}
      />
      <OpsCard
        tone="red"
        to="/history"
        icon={<CircleAlert className="size-3.5" />}
        title={messages.overview.failed}
        value={messages.common.cases(model.failed)}
        hint={messages.overview.failedHint}
      />
    </PanelBody>
  );
}
