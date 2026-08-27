import type { ExtractRecord } from "@/types/extract";
import type { EtlJob } from "@/types/job";
import type { SystemHealth } from "@/types/system";
import type { DayPoint } from "@/lib/overview";

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

export type FeedItem = {
  id: string;
  kind: "extract" | "transform";
  title: string;
  status: string;
  at: string;
  to: string;
  error: string | null;
};

export type DashboardModel = {
  systemHealth: SystemHealth | null;
  recentJobs: EtlJob[];
  recentExtracts: ExtractRecord[];
  workspaceCount: number;
  activeChipCount: number;
  datasetCount: number;
  connectionCount: number;
  running: number;
  queued: number;
  succeeded: number;
  failed: number;
  active: number;
  bar: number;
  days: DayPoint[];
  feed: FeedItem[];
  attention: FeedItem[];
  extractRate: number | null;
  transformRate: number | null;
  funnelMax: number;
};
