import { PanelBody } from "@/components/ui/panel";
import { useLanguage } from "@/i18n/LanguageProvider";
import { useDashboard } from "@/hooks/overview/DashboardContext";
import { AssetsChart } from "../charts";

export function AssetsWidget() {
  const { messages } = useLanguage();
  const { model } = useDashboard();

  return (
    <PanelBody className="h-full min-h-0">
      <AssetsChart
        totalLabel={messages.overview.assetsTotal}
        items={[
          {
            label: messages.overview.workspaces,
            value: model.workspaceCount,
            accent: "#1769c2",
            to: "/workspace",
          },
          {
            label: messages.overview.activeChips,
            value: model.activeChipCount,
            accent: "#287a4b",
            to: "/workspace",
          },
          {
            label: messages.overview.datasets,
            value: model.datasetCount,
            accent: "#9a6700",
            to: "/transform",
          },
          {
            label: messages.overview.connectionsAsset,
            value: model.connectionCount,
            accent: "#c43835",
            to: "/connections",
          },
        ]}
      />
    </PanelBody>
  );
}
