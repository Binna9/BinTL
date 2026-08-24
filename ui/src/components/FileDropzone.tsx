import { InputHTMLAttributes } from "react";
import { useLanguage } from "@/i18n/LanguageProvider";

export function FileDropzone({
  chosen,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { chosen: string }) {
  const { messages } = useLanguage();
  return (
    <label className="flex h-20 cursor-pointer items-center justify-center border border-dashed border-border-strong bg-raised text-[13px] text-text-secondary hover:bg-subtle">
      <input className="hidden" type="file" {...props} />
      {chosen || messages.fileDropzone.prompt}
    </label>
  );
}
