import { CircleCheck } from "lucide-react";
import { PanelBody } from "@/components/ui/panel";
import { useLanguage } from "@/i18n/LanguageProvider";
import { useDashboard } from "@/hooks/overview/DashboardContext";
import { FeedRow } from "./parts";

export function AttentionWidget() {
  const { messages } = useLanguage();
  const { model } = useDashboard();

  if (model.attention.length === 0) {
    return (
      <PanelBody>
        <p className="flex items-center gap-2 text-sm text-success">
          <CircleCheck className="size-4" />
          {messages.overview.attentionEmpty}
        </p>
      </PanelBody>
    );
  }

  return (
    <ul className="scroll-pane min-h-0 flex-1 divide-y divide-border overflow-auto">
      {model.attention.map((item) => (
        <li key={`${item.kind}-${item.id}`}>
          <FeedRow item={item} detail showArrow />
        </li>
      ))}
    </ul>
  );
}
