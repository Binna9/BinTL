import { PanelBody } from "@/components/ui/panel";
import { useLanguage } from "@/i18n/LanguageProvider";
import { useDashboard } from "@/hooks/overview/DashboardContext";
import { FlowChart } from "../charts";

export function FunnelWidget() {
  const { messages } = useLanguage();
  const { model } = useDashboard();
  const { recentExtracts, recentJobs, extractRate, transformRate } = model;

  return (
    <PanelBody className="flex h-full min-h-0 flex-col gap-2">
      <div className="min-h-0 flex-1">
        <FlowChart
          stages={[
            { name: messages.overview.extract, value: recentExtracts.length, to: "/extracts" },
            { name: messages.overview.transform, value: recentJobs.length, to: "/transform" },
            { name: messages.overview.load, value: 0, to: "/load" },
          ]}
        />
      </div>
      <p className="shrink-0 text-[11px] leading-4 text-text-tertiary">
        {extractRate == null
          ? `${messages.overview.extract} · ${messages.overview.noRate}`
          : `${messages.overview.extract} · ${messages.overview.successRate(extractRate)}`}
        {" · "}
        {transformRate == null
          ? `${messages.overview.transform} · ${messages.overview.noRate}`
          : `${messages.overview.transform} · ${messages.overview.successRate(transformRate)}`}
      </p>
    </PanelBody>
  );
}
