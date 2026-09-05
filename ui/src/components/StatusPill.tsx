import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";

const tone: Record<string, string> = {
  queued: "text-text-secondary before:bg-text-tertiary",
  running: "text-accent before:bg-accent",
  succeeded: "text-success before:bg-success",
  failed: "text-danger before:bg-danger",
  canceled: "text-text-tertiary before:bg-text-tertiary",
};

export function StatusPill({ value, label }: { value: string; label?: string }) {
  const { messages } = useLanguage();
  const labels: Record<string, string> = messages.status;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium before:size-1.5 before:rounded-full",
        tone[value] ?? "text-text-secondary before:bg-text-tertiary",
      )}
    >
      {label ?? labels[value] ?? value}
    </span>
  );
}
