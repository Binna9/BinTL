import { Cable, User } from "lucide-react";
import { PanelBody } from "@/components/ui/panel";
import { useLanguage } from "@/i18n/LanguageProvider";
import { useDashboard } from "@/hooks/overview/DashboardContext";
import type { AssetScope } from "../types";
import { AssetsChart } from "../charts";
import { DashScopeToggle } from "./parts";

export function AssetsScopeToggle() {
  const { messages } = useLanguage();
  const { assetScope, setAssetScope } = useDashboard();

  return (
    <DashScopeToggle<AssetScope>
      value={assetScope}
      onChange={setAssetScope}
      label={messages.overview.assetsScope}
      options={[
        { id: "mine", label: messages.overview.assetsMine, icon: <User className="size-3.5" /> },
        { id: "shared", label: messages.overview.assetsShared, icon: <Cable className="size-3.5" /> },
      ]}
    />
  );
}

export function AssetsWidget() {
  const { messages } = useLanguage();
  const { model, assetScope } = useDashboard();
  const assets = assetScope === "mine" ? model.mineAssets : model.sharedAssets;
  const items =
    assetScope === "mine"
      ? [
          {
            label: messages.overview.workspaces,
            value: assets.workspaces,
            accent: "#1769c2",
            to: "/workspace",
          },
          {
            label: messages.overview.activeChips,
            value: assets.chips,
            accent: "#287a4b",
            to: "/workspace",
          },
          {
            label: messages.overview.datasets,
            value: assets.datasets,
            accent: "#9a6700",
            to: "/transform",
          },
        ]
      : [
          {
            label: messages.overview.connectionsAsset,
            value: assets.connections,
            accent: "#c43835",
            to: "/connections",
          },
        ];

  return (
    <PanelBody className="h-full min-h-0">
      <AssetsChart totalLabel={messages.overview.assetsTotal} items={items} />
    </PanelBody>
  );
}
