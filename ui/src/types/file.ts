export interface StoredFile {
  id: string;
  filename: string;
  size: number;
  stored_path: string;
}

export interface WorkbookSheet {
  index: number;
  name: string;
}

export interface StagedWorkbook {
  staging_id: string;
  original_filename: string;
  format: "xls" | "xlsx";
  sheets: WorkbookSheet[];
}

export interface WorkbookSheetSelection {
  name: string;
  filename: string;
  delimiter?: string;
}

export interface CommitWorkbookResponse {
  files: StoredFile[];
}

export interface FilePreview {
  id: string;
  filename: string;
  stored_path: string;
  delimiter: string;
  has_header: boolean;
  columns: string[];
  rows: string[][];
  row_count: number;
  truncated: boolean;
}
