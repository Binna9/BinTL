import { InputHTMLAttributes } from "react";

export function FileDropzone({
  chosen,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { chosen: string }) {
  return (
    <label className="flex h-20 cursor-pointer items-center justify-center border border-dashed border-border-strong bg-raised text-[13px] text-text-secondary hover:bg-subtle">
      <input className="hidden" type="file" {...props} />
      {chosen || "파일을 선택한 뒤 업로드하세요"}
    </label>
  );
}
