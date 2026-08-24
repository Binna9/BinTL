import { useCallback, useEffect, useState } from "react";
import { fileApi } from "@/services/fileApi";
import { useLanguage } from "@/i18n/LanguageProvider";
import type { StoredFile } from "@/types/file";

export function useFiles() {
  const { messages } = useLanguage();
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [filesError, setFilesError] = useState("");

  const refreshFiles = useCallback(async () => {
    const response = await fileApi.getFiles();
    setFiles(response.files);
  }, []);

  useEffect(() => {
    void refreshFiles().catch((error) =>
      setFilesError(error instanceof Error ? error.message : messages.errors.files),
    );
  }, [refreshFiles, messages]);

  return { files, filesError, setFilesError, refreshFiles };
}
