import { httpRequest } from "@/services/httpClient";
import type {
  CommitWorkbookResponse,
  FilePreview,
  StagedWorkbook,
  StoredFile,
  WorkbookSheetSelection,
} from "@/types/file";

interface FileListResponse {
  files: StoredFile[];
}

export const fileApi = {
  getFiles: () => httpRequest<FileListResponse>("/api/files"),
  uploadFile: (file: File, filename?: string) => {
    const body = new FormData();
    const name = filename?.trim();
    if (name) body.append("filename", name);
    body.append("file", file);
    return httpRequest<StoredFile>("/api/files", { method: "POST", body });
  },
  stageWorkbook: (file: File) => {
    const body = new FormData();
    body.append("file", file);
    return httpRequest<StagedWorkbook>("/api/files/stage", {
      method: "POST",
      body,
    });
  },
  commitWorkbook: (
    stagingId: string,
    sheets: WorkbookSheetSelection[],
    options?: { delimiter?: string; header?: boolean; addSequence?: boolean },
  ) =>
    httpRequest<CommitWorkbookResponse>("/api/files/commit", {
      method: "POST",
      body: JSON.stringify({
        staging_id: stagingId,
        sheets,
        delimiter: options?.delimiter?.trim() || ",",
        header: options?.header ?? true,
        add_sequence: options?.addSequence ?? false,
      }),
    }),
  cancelWorkbook: (stagingId: string) =>
    httpRequest<void>(`/api/files/stage/${stagingId}`, { method: "DELETE" }),
  deleteFile: (id: string) =>
    httpRequest<{ ok: boolean }>(`/api/files/${id}`, { method: "DELETE" }),
  previewFile: (id: string, limit = 200) =>
    httpRequest<FilePreview>(`/api/files/${id}/preview?limit=${limit}`),
};
