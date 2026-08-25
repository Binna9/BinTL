import { useCallback, useEffect, useState } from "react";
import { fileApi } from "@/services/fileApi";
import { useLanguage } from "@/i18n/LanguageProvider";
import { toastError } from "@/lib/notifications";
import type { StoredFile } from "@/types/file";

export function useFiles() {
  const { messages } = useLanguage();
  const [files, setFiles] = useState<StoredFile[]>([]);

  const refreshFiles = useCallback(async () => {
    const response = await fileApi.getFiles();
    setFiles(response.files);
  }, []);

  useEffect(() => {
    void refreshFiles().catch((error) =>
      toastError(messages.errors.files, error),
    );
  }, [refreshFiles, messages]);

  return { files, refreshFiles };
}
