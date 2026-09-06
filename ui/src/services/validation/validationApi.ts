import { httpRequest } from "@/services/httpClient";

export interface ValidationReport {
  passed: boolean; source_rows: number; target_rows: number;
  missing_keys: number; extra_keys: number;
  duplicate_source_keys: number; duplicate_target_keys: number;
  mismatched_rows: number; schema_matches: boolean; samples: string[];
}

export interface ValidationRule {
  id: string; name: string; description: string; keys: string[]; columns: string[];
  compare_row_count: boolean; compare_schema: boolean; active: boolean; revision: number;
  created_at: string; updated_at: string;
}

export interface ValidationResult {
  id: string; workspace_id: string; validation_rule_id?: string | null;
  execution_step_id?: string | null; source_data_file_id: string; target_data_file_id: string;
  passed: boolean; report: ValidationReport; created_at: string;
}

export type SaveValidationRule = Omit<ValidationRule, "id" | "revision" | "created_at" | "updated_at">;

export const validationApi = {
  run: (body: { source_data_file_id: string; target_data_file_id: string; validation_rule_id?: string; keys: string[]; columns: string[] }) =>
    httpRequest<{ result_id: string; report: ValidationReport }>("/api/validations/run", { method: "POST", body: JSON.stringify(body) }),
  listRules: () => httpRequest<{ rules: ValidationRule[] }>("/api/validation-rules"),
  createRule: (body: SaveValidationRule) => httpRequest<ValidationRule>("/api/validation-rules", { method: "POST", body: JSON.stringify(body) }),
  updateRule: (id: string, body: SaveValidationRule) => httpRequest<ValidationRule>(`/api/validation-rules/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteRule: (id: string) => httpRequest<{ ok: true }>(`/api/validation-rules/${id}`, { method: "DELETE" }),
  listResults: () => httpRequest<{ results: ValidationResult[] }>("/api/validation-results"),
};
