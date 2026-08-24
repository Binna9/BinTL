import { httpRequest } from "@/services/httpClient";
import type { StoredFile } from "@/types/file";

interface FileListResponse {
  files: StoredFile[];
}

export const fileApi = {
  getFiles: () => httpRequest<FileListResponse>("/api/files"),
  uploadFile: (file: File) => {
    const body = new FormData();
    body.append("file", file);
    return httpRequest<StoredFile>("/api/files", { method: "POST", body });
  },
};
