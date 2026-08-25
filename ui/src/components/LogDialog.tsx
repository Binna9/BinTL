import { ReactNode, useEffect, useRef } from "react";
import { ScrollText } from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { useLanguage } from "@/i18n/LanguageProvider";

export function LogDialog({
  open,
  title,
  text,
  icon,
  defaultOffset = { x: 112, y: 0 },
  onClose,
}: {
  open: boolean;
  title: string;
  text: string;
  icon?: ReactNode;
  defaultOffset?: { x: number; y: number };
  onClose: () => void;
}) {
  const { messages } = useLanguage();
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const node = preRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [text, open]);

  return (
    <AppDialog
      open={open}
      title={title}
      icon={icon ?? <ScrollText className="size-4 text-accent" aria-hidden="true" />}
      className="h-[min(28rem,70vh)] w-[min(42rem,94vw)]"
      overlayClassName="bg-workspace/50"
      zIndex={120}
      minWidth={320}
      minHeight={200}
      defaultOffset={defaultOffset}
      onClose={onClose}
    >
      <pre
        ref={preRef}
        className="m-0 min-h-0 flex-1 overflow-auto bg-[#171a1f] p-4 font-sans text-[12px] leading-5 text-[#d7dce2]"
      >
        {text.trim() || messages.empty.logs}
      </pre>
    </AppDialog>
  );
}
