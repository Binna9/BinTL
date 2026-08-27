import { Tag } from "lucide-react";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";

export function ReleaseBadge({ className }: { className?: string }) {
  const { messages } = useLanguage();
  return (
    <span className={cn("release-badge", className)}>
      <Tag className="release-badge-icon" strokeWidth={2} aria-hidden="true" />
      <span className="release-badge-label">{messages.login.release}</span>
      <span className="release-badge-ver">{messages.login.releaseVersion}</span>
    </span>
  );
}
