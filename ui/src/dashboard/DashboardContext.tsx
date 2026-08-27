import { createContext, ReactNode, useContext, useMemo } from "react";
import { useOverviewData } from "@/hooks/useOverviewData";
import { buildDashboardModel } from "./model";
import { useDashboardLayout } from "./useDashboardLayout";
import type { DashboardModel } from "./types";

type DashboardContextValue = {
  model: DashboardModel;
} & ReturnType<typeof useDashboardLayout>;

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function DashboardProvider({ children }: { children: ReactNode }) {
  const data = useOverviewData();
  const layoutState = useDashboardLayout();
  const model = useMemo(
    () =>
      buildDashboardModel({
        systemHealth: data.systemHealth,
        recentJobs: data.recentJobs,
        recentExtracts: data.recentExtracts,
        workspaceCount: data.workspaceCount,
        activeChipCount: data.activeChipCount,
        datasetCount: data.datasetCount,
        connectionCount: data.connectionCount,
      }),
    [
      data.systemHealth,
      data.recentJobs,
      data.recentExtracts,
      data.workspaceCount,
      data.activeChipCount,
      data.datasetCount,
      data.connectionCount,
    ],
  );

  const value = useMemo(
    () => ({ model, ...layoutState }),
    [model, layoutState],
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
