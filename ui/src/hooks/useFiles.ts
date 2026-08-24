import { useCallback, useEffect, useState } from "react";
import { fileApi } from "@/services/fileApi";
import type { StoredFile } from "@/types/file";

export function useFiles() {
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [filesError, setFilesError] = useState("");

  const refreshFiles = useCallback(async () => {
    const response = await fileApi.getFiles();
    setFiles(response.files);
  }, []);

  useEffect(() => {
    void refreshFiles().catch((error) =>
      setFilesError(error instanceof Error ? error.message : "파일 목록을 불러오지 못했습니다"),
    );
  }, [refreshFiles]);

  return { files, filesError, setFilesError, refreshFiles };
}
