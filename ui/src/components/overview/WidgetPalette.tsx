import { LayoutGrid, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/i18n/LanguageProvider";
import { useDashboard } from "@/hooks/overview/DashboardContext";
import { WIDGETS } from "./registry";

export function WidgetPalette() {
  const { messages } = useLanguage();
  const { reset } = useDashboard();
  return (
    <Button type="button" variant="quiet" onClick={reset}>
      <RotateCcw className="size-3.5" aria-hidden="true" />
      {messages.overview.resetLayout}
    </Button>
  );
}

export function ClosedWidgetBar() {
  const { messages } = useLanguage();
  const { hidden, show } = useDashboard();
  if (hidden.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-xl border border-border bg-surface px-3.5 py-2.5">
      <span className="inline-flex items-center gap-2 text-[12px] font-semibold text-text-secondary">
        <LayoutGrid className="size-3.5" aria-hidden="true" />
        {messages.overview.addWidget}
      </span>
      {hidden.map((item) => {
        const def = WIDGETS[item.id];
        const title = def.title(messages);
        const Icon = def.icon;
        return (
          <button
            key={item.id}
            type="button"
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-subtle px-2.5 py-1 text-[12px] font-medium text-text outline-none hover:border-accent/40 hover:bg-accent-subtle focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={() => show(item.id)}
          >
            <Icon className="size-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
            {title}
          </button>
        );
      })}
    </div>
  );
}
