import { Link } from "react-router-dom";
import { cn } from "@/lib/cn";
import {
  transformEditorPath,
  type TransformEditorMode,
} from "@/lib/transformEditor";
import type { Messages } from "@/i18n/ko";

const MODES: TransformEditorMode[] = ["clean", "combine", "aggregate"];

export function TransformModeNav({
  mode,
  transformId,
  search,
  messages,
}: {
  mode: TransformEditorMode;
  transformId?: string;
  search: string;
  messages: Messages;
}) {
  const labels: Record<TransformEditorMode, string> = {
    clean: messages.transform.title,
    combine: messages.transform.combineTitle,
    aggregate: messages.transform.aggregateTitle,
    reshape: messages.transform.reshapeTitle,
  };

  return (
    <nav
      className="flex shrink-0 gap-1 border-b border-border bg-surface px-3"
      aria-label={messages.transform.eyebrow}
    >
      {MODES.map((tab) => (
        <Link
          key={tab}
          to={transformEditorPath(tab, transformId, search)}
          className={cn(
            "border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors",
            mode === tab
              ? "border-accent text-accent"
              : "border-transparent text-text-secondary hover:text-text",
          )}
          aria-current={mode === tab ? "page" : undefined}
        >
          {labels[tab]}
        </Link>
      ))}
    </nav>
  );
}

export function useTransformEditorMode(pathname: string): TransformEditorMode {
  if (pathname.includes("/transform/combine")) return "combine";
  if (pathname.includes("/transform/aggregate")) return "aggregate";
  if (pathname.includes("/transform/reshape")) return "reshape";
  return "clean";
}
