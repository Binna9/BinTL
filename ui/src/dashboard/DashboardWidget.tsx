import { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { X } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { ResizeGrip } from "@/components/ui/resize-grip";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { useDashboard } from "./DashboardContext";
import { WIDGETS } from "./registry";
import type { WidgetId } from "./types";

export function DashboardWidget({
  id,
  interactive,
  floating,
  style,
  onMoveStart,
  onResizeStart,
}: {
  id: WidgetId;
  interactive: boolean;
  floating?: boolean;
  style: CSSProperties;
  onMoveStart: (event: ReactPointerEvent<HTMLElement>, id: WidgetId) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>, id: WidgetId) => void;
}) {
  const { messages } = useLanguage();
  const { hide, resetSize } = useDashboard();
  const def = WIDGETS[id];
  const Icon = def.icon;
  const HeaderExtra = def.headerExtra;
  const Body = def.Component;
  const title = def.title(messages);

  return (
    <Panel
      className={cn("absolute flex flex-col", floating && "z-20 shadow-xl")}
      style={style}
      aria-label={title}
    >
      <PanelHeader
        className={cn(
          "shrink-0",
          interactive && "cursor-grab touch-none active:cursor-grabbing",
        )}
        onPointerDown={interactive ? (event) => onMoveStart(event, id) : undefined}
        icon={<Icon className="size-3.5" aria-hidden="true" />}
        title={title}
        description={def.description(messages)}
        actions={
          <>
            {HeaderExtra ? <HeaderExtra /> : null}
            <button
              type="button"
              className="grid size-8 shrink-0 place-items-center rounded-lg text-text-secondary outline-none transition-colors hover:bg-subtle hover:text-text focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label={messages.overview.closeWidget}
              title={messages.overview.closeWidget}
              onClick={() => hide(id)}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Body />
      </div>
      {interactive ? (
        <ResizeGrip
          label={messages.overview.resizeWidget}
          onPointerDown={(event) => onResizeStart(event, id)}
          onDoubleClick={() => resetSize(id)}
        />
      ) : null}
    </Panel>
  );
}
