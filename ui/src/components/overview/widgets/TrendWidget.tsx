import { PanelBody } from "@/components/ui/panel";
import { useLanguage } from "@/i18n/LanguageProvider";
import { useDashboard } from "@/hooks/overview/DashboardContext";
import { TrendChart } from "../charts";

export function TrendLegend() {
  const { messages } = useLanguage();
  return (
    <span className="dash-legend">
      <span>
        <i className="bg-accent" />
        {messages.overview.extract}
      </span>
      <span>
        <i className="bg-success" />
        {messages.overview.transform}
      </span>
      <span>
        <i className="bg-warning" />
        {messages.overview.load}
      </span>
    </span>
  );
}

export function TrendWidget() {
  const { model } = useDashboard();
  return (
    <PanelBody className="h-full min-h-0">
      <TrendChart days={model.days} />
    </PanelBody>
  );
}
