import { DragEvent, useRef, useState } from "react";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";

export function FileDropzone({
  onFiles,
  disabled = false,
  accept,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  accept?: string;
}) {
  const { messages } = useLanguage();
  const [over, setOver] = useState(false);
  const dragCount = useRef(0);

  function takeFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    onFiles(Array.from(list));
  }

  function onDragEnter(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    dragCount.current += 1;
    setOver(true);
  }

  function onDragLeave(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    dragCount.current = Math.max(0, dragCount.current - 1);
    if (dragCount.current === 0) setOver(false);
  }

  function onDragOver(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    dragCount.current = 0;
    setOver(false);
    if (disabled) return;
    takeFiles(event.dataTransfer.files);
  }

  return (
    <label
      className={cn("file-dropzone", over && "is-over", disabled && "pointer-events-none opacity-60")}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <input
        className="hidden"
        type="file"
        multiple
        accept={accept}
        disabled={disabled}
        onChange={(event) => {
          takeFiles(event.target.files);
          event.target.value = "";
        }}
      />
      {messages.fileDropzone.prompt}
    </label>
  );
}
