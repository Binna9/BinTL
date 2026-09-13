import type { ChipKind } from "@/types/chip";
import type { SystemHealth } from "@/types/system";

export const WIDGET_IDS = [
  "summary",
  "assets",
  "trend",
  "funnel",
  "attention",
  "start",
  "activity",
] as const;

export type WidgetId = (typeof WIDGET_IDS)[number];

export type WidgetLayout = {
  id: WidgetId;
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
};

export type SummaryScope = "chip" | "workspace";
export type AssetScope = "mine" | "shared";

export type AssetCounts = {
  workspaces: number;
  chips: number;
  datasets: number;
  connections: number;
};

export type FeedItem = {
  id: string;
  kind: ChipKind;
  title: string;
  status: string;
  at: string;
  to: string;
  error: string | null;
};

export type OpsStats = {
  running: number;
  queued: number;
  succeeded: number;
  failed: number;
  active: number;
  bar: number;
};

export type DashboardModel = {
  systemHealth: SystemHealth | null;
  mineAssets: AssetCounts;
  sharedAssets: AssetCounts;
  chipOps: OpsStats;
  workspaceOps: OpsStats;
  trendRuns: { kind: ChipKind; created_at: string }[];
  feed: FeedItem[];
  attention: FeedItem[];
  extractCount: number;
  transformCount: number;
  loadCount: number;
  sqlCount: number;
  validationCount: number;
  extractRate: number | null;
  transformRate: number | null;
  loadRate: number | null;
  sqlRate: number | null;
  validationRate: number | null;
};
