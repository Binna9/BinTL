import type { ComponentType } from "react";
import {
  Activity,
  Boxes,
  CircleAlert,
  GitBranch,
  ListChecks,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { Messages } from "@/i18n/ko";
import type { WidgetId } from "./types";
import { ActivityWidget } from "./widgets/ActivityWidget";
import { AssetsWidget } from "./widgets/AssetsWidget";
import { AttentionWidget } from "./widgets/AttentionWidget";
import { FunnelWidget } from "./widgets/FunnelWidget";
import { StartWidget } from "./widgets/StartWidget";
import { SummaryWidget } from "./widgets/SummaryWidget";
import { TrendLegend, TrendWidget } from "./widgets/TrendWidget";

export type WidgetDef = {
  icon: LucideIcon;
  title: (messages: Messages) => string;
  description: (messages: Messages) => string;
  headerExtra?: ComponentType;
  Component: ComponentType;
};

export const WIDGETS: Record<WidgetId, WidgetDef> = {
  summary: {
    icon: Activity,
    title: (messages) => messages.overview.summary,
    description: (messages) => messages.overview.summaryDescription,
    Component: SummaryWidget,
  },
  assets: {
    icon: Boxes,
    title: (messages) => messages.overview.assets,
    description: (messages) => messages.overview.assetsDescription,
    Component: AssetsWidget,
  },
  trend: {
    icon: Activity,
    title: (messages) => messages.overview.trend,
    description: (messages) => messages.overview.trendDescription,
    headerExtra: TrendLegend,
    Component: TrendWidget,
  },
  funnel: {
    icon: GitBranch,
    title: (messages) => messages.overview.funnel,
    description: (messages) => messages.overview.funnelDescription,
    Component: FunnelWidget,
  },
  attention: {
    icon: CircleAlert,
    title: (messages) => messages.overview.attention,
    description: (messages) => messages.overview.attentionDescription,
    Component: AttentionWidget,
  },
  start: {
    icon: Sparkles,
    title: (messages) => messages.overview.start,
    description: (messages) => messages.overview.startDescription,
    Component: StartWidget,
  },
  activity: {
    icon: ListChecks,
    title: (messages) => messages.overview.activity,
    description: (messages) => messages.overview.activityDescription,
    Component: ActivityWidget,
  },
};
