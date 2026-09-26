export type ScheduleType = "interval";
export type ScheduleUnit = "second" | "minute" | "hour" | "day" | "month" | "year";
export interface WorkspaceSchedule {
  id: string; workspace_id: string; name: string; schedule_type: ScheduleType;
  interval_value: number; interval_unit: ScheduleUnit; second?: number | null;
  hour?: number | null; minute?: number | null; day_of_month?: number | null;
  month_of_year?: number | null; timezone: string; enabled: boolean; next_run_at: string;
  last_run_at?: string | null; last_status?: string | null; created_at: string; updated_at: string;
}
export interface ScheduleRequest {
  workspace_id: string; name: string; schedule_type: ScheduleType; interval_value: number;
  interval_unit: ScheduleUnit; second?: number; hour?: number; minute?: number;
  day_of_month?: number; month_of_year?: number; enabled: boolean;
}
