import { cn } from "@/lib/cn";

const tone: Record<string, string> = {
  queued: "text-text-secondary before:bg-text-tertiary",
  running: "text-accent before:bg-accent",
  succeeded: "text-success before:bg-success",
  failed: "text-danger before:bg-danger",
  canceled: "text-text-tertiary before:bg-text-tertiary",
};

const label: Record<string, string> = {
  queued: "대기",
  running: "실행 중",
  succeeded: "완료",
  failed: "실패",
  canceled: "취소",
};

export function StatusPill({ value }: { value: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium before:size-1.5 before:rounded-full",
        tone[value] ?? "text-text-secondary before:bg-text-tertiary",
      )}
    >
      {label[value] ?? value}
    </span>
  );
}
