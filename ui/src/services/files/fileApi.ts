import { HttpError, httpNdjson, httpRequest } from "@/services/httpClient";
import type {
  CommitWorkbookResponse,
  FilePreview,
  StagedWorkbook,
  StoredFile,
  WorkbookCommitProgress,
  WorkbookSheetSelection,
} from "@/types/file";

interface FileListResponse {
  files: StoredFile[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
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
  commitWorkbook: async (
    stagingId: string,
    sheets: WorkbookSheetSelection[],
    options?: {
      delimiter?: string;
      header?: boolean;
      addSequence?: boolean;
      onProgress?: (progress: WorkbookCommitProgress) => void;
    },
  ) => {
    let result: CommitWorkbookResponse | undefined;
    await httpNdjson(
      "/api/files/commit",
      {
        method: "POST",
        immediate: true,
        body: JSON.stringify({
          staging_id: stagingId,
          sheets,
          delimiter: options?.delimiter?.trim() || ",",
          header: options?.header ?? true,
          add_sequence: options?.addSequence ?? false,
        }),
      },
      (event) => {
        const data = asRecord(event);
        if (!data) return;
        const type = data.type;
        if (type === "progress") {
          options?.onProgress?.({
            current: typeof data.current === "number" ? data.current : 0,
            total: typeof data.total === "number" ? data.total : sheets.length,
            name: typeof data.name === "string" ? data.name : "",
          });
          return;
        }
        if (type === "error") {
          throw new HttpError(
            400,
            typeof data.error === "string" ? data.error : "workbook commit failed",
          );
        }
        if (type === "done" || Array.isArray(data.files)) {
          result = {
            files: Array.isArray(data.files) ? (data.files as StoredFile[]) : [],
          };
        }
      },
    );
    if (!result) {
      throw new HttpError(500, "workbook commit produced no result");
    }
    return result;
  },
  cancelWorkbook: (stagingId: string) =>
    httpRequest<void>(`/api/files/stage/${stagingId}`, { method: "DELETE" }),
  deleteFile: (id: string) =>
    httpRequest<{ ok: boolean }>(`/api/files/${id}`, { method: "DELETE" }),
  previewFile: (id: string, limit = 200) =>
    httpRequest<FilePreview>(`/api/files/${id}/preview?limit=${limit}`),
};
