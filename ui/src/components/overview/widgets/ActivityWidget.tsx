import { PanelBody } from "@/components/ui/panel";
import { StatusPill } from "@/components/StatusPill";
import { useLanguage } from "@/i18n/LanguageProvider";
import { useDashboard } from "@/hooks/overview/DashboardContext";
import { FeedRow } from "./parts";

export function ActivityWidget() {
  const { messages } = useLanguage();
  const { model } = useDashboard();

  if (model.feed.length === 0) {
    return (
      <PanelBody>
        <p className="text-sm text-text-secondary">{messages.overview.activityEmpty}</p>
      </PanelBody>
    );
  }

  return (
    <ul className="scroll-pane min-h-0 flex-1 divide-y divide-border overflow-auto">
      {model.feed.slice(0, 8).map((item) => (
        <li key={`${item.kind}-${item.id}`}>
          <FeedRow item={item} extra={<StatusPill value={item.status} />} />
        </li>
      ))}
    </ul>
  );
}
