import { createContext, ReactNode, useContext, useMemo, useState } from "react";
import { useOverviewData } from "./useOverviewData";
import { buildDashboardModel } from "@/components/overview/model";
import { useDashboardLayout } from "./useDashboardLayout";
import type { AssetScope, DashboardModel, SummaryScope } from "@/components/overview/types";

type DashboardContextValue = {
  model: DashboardModel;
  summaryScope: SummaryScope;
  setSummaryScope: (scope: SummaryScope) => void;
  assetScope: AssetScope;
  setAssetScope: (scope: AssetScope) => void;
} & ReturnType<typeof useDashboardLayout>;

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function DashboardProvider({ children }: { children: ReactNode }) {
  const data = useOverviewData();
  const layoutState = useDashboardLayout();
  const [summaryScope, setSummaryScope] = useState<SummaryScope>("chip");
  const [assetScope, setAssetScope] = useState<AssetScope>("mine");
  const model = useMemo(
    () =>
      buildDashboardModel({
        systemHealth: data.systemHealth,
        chipRuns: data.chipRuns,
        workspaceRuns: data.workspaceRuns,
        mineAssets: data.mineAssets,
        sharedAssets: data.sharedAssets,
      }),
    [
      data.systemHealth,
      data.chipRuns,
      data.workspaceRuns,
      data.mineAssets,
      data.sharedAssets,
    ],
  );

  const value = useMemo(
    () => ({ model, summaryScope, setSummaryScope, assetScope, setAssetScope, ...layoutState }),
    [model, summaryScope, assetScope, layoutState],
  );

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}

export function useDashboard() {
  const context = useContext(DashboardContext);
  if (!context) {
    throw new Error("useDashboard must be used within DashboardProvider");
  }
  return context;
}
