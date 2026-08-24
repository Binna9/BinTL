import { Database } from "lucide-react";
import { cn } from "@/lib/cn";
import type { DataConnection } from "@/types/connection";

function ConnectionInfoItem({
  label,
  value,
  technical = false,
}: {
  label: string;
  value: string;
  technical?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 truncate text-[12px] text-text-secondary",
          technical && "technical",
        )}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

export function ConnectionInfoPanel({
  connection,
  selectedTable,
}: {
  connection?: DataConnection;
  selectedTable?: string;
}) {
  if (!connection) {
    return (
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
        <div className="grid size-9 place-items-center rounded-lg border border-border bg-raised text-text-tertiary">
          <Database className="size-4" />
        </div>
        <div>
          <div className="text-[12px] font-medium text-text-secondary">커넥션이 선택되지 않았습니다</div>
          <div className="mt-0.5 text-[11px] text-text-tertiary">
            왼쪽 목록에서 조회할 데이터베이스를 선택하세요.
          </div>
        </div>
      </div>
    );
  }

  return (
    <section
      className="flex h-16 shrink-0 items-center gap-4 overflow-hidden border-b border-border bg-surface px-4"
      aria-label="선택한 커넥션 정보"
    >
      <div className="flex min-w-40 shrink-0 items-center gap-3 border-r border-border pr-4">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-subtle text-accent">
          <Database className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-text">{connection.name}</div>
          <div className="mt-1 flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
            <span className="truncate text-[10px] uppercase tracking-[0.06em] text-text-tertiary">
              {connection.driver}
            </span>
          </div>
        </div>
      </div>

      <div className="grid min-w-0 flex-1 grid-cols-4 gap-5 overflow-hidden">
        <ConnectionInfoItem
          label="Endpoint"
          value={`${connection.host}:${connection.port}`}
          technical
        />
        <ConnectionInfoItem label="Database" value={connection.database_name} technical />
        <ConnectionInfoItem label="User" value={connection.username} technical />
        <ConnectionInfoItem label="Selected table" value={selectedTable || "—"} technical />
      </div>
    </section>
  );
}
