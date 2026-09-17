import { ClipboardList, ScrollText } from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { ChipDetailView } from "@/components/chips/ChipDetailView";
import { StatusPill } from "@/components/StatusPill";
import { Button } from "@/components/ui/button";
import { chipKindLabel } from "@/features/workspace/workspaceCanvasModel";
import { useLanguage } from "@/i18n/LanguageProvider";
import type { Messages } from "@/i18n/ko";
import { fmtBytes, fmtSqlPreview, runDurationMs } from "@/lib/format";
import {
  parseExtractConfig,
  parseLoadConfig,
  parseTransformConfig,
} from "@/lib/chipDetail";
import { cn } from "@/lib/cn";
import type { ValidationReport } from "@/services/validation/validationApi";
import type { Chip, ChipRun } from "@/types/chip";
import type { Dataset } from "@/types/dataset";

export function WorkspaceRunReportDialog({
  open,
  title,
  status,
  chips,
  runs,
  datasets,
  onClose,
  onViewLog,
}: {
  open: boolean;
  title: string;
  status: string;
  chips: Chip[];
  runs: ChipRun[];
  datasets: Dataset[];
  onClose: () => void;
  onViewLog?: (chip: Chip) => void;
}) {
  const { messages } = useLanguage();
  const steps = [...runs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const succeeded = steps.filter((run) => run.status === "succeeded").length;
  const totalMs = runDurationMs(steps[0]?.started_at ?? steps[0]?.created_at, steps.at(-1)?.finished_at);
  const byId = new Map(chips.map((chip) => [chip.id, chip]));
  const files = new Map(datasets.map((item) => [item.id, item]));

  return (
    <AppDialog
      open={open}
      title={title}
      icon={<ClipboardList className="size-4 text-accent" aria-hidden="true" />}
      className="h-[min(46rem,90vh)] w-[min(44rem,94vw)]"
      minWidth={420}
      minHeight={360}
      headerExtra={
        <div className="flex flex-1 items-center justify-end">
          <StatusPill value={status} />
        </div>
      }
      onClose={onClose}
    >
      <div className="scroll-pane min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-subtle/50 px-3 py-2.5 text-xs">
          <span className="font-semibold text-text">{messages.workspace.runReportSummary(succeeded, steps.length)}</span>
          {totalMs != null ? (
            <span className="text-text-secondary">{messages.workspace.runReportDuration} {messages.common.duration(totalMs)}</span>
          ) : null}
        </div>
        <ol className="grid gap-3">
          {steps.map((run, index) => {
            const live = byId.get(run.chip_id);
            const chip: Chip = live
              ? { ...live, config: run.config_snapshot }
              : {
                  id: run.chip_id,
                  owner_user_id: "",
                  name: messages.chipRuns.unknownChip,
                  kind: run.kind,
                  workspace_id: run.workspace_id,
                  config: run.config_snapshot,
                  revision: 0,
                  active: true,
                  created_at: run.created_at,
                  updated_at: run.created_at,
                };
            const output = run.output_dataset_id ? files.get(run.output_dataset_id) : undefined;
            const input = run.input_dataset_id ? files.get(run.input_dataset_id) : undefined;
            return (
                  <li
                    key={run.id}
                    aria-label={messages.workspace.runReportStep(index + 1, chipKindLabel(run.kind, messages), chip.name)}
                    className="overflow-hidden rounded-2xl border border-border/80 bg-surface shadow-[0_10px_30px_rgba(15,23,42,0.045)]"
                  >
                <header className="flex items-start gap-3 border-b border-border/70 bg-gradient-to-r from-subtle/90 to-surface px-3.5 py-3">
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-surface text-[11px] font-bold text-text ring-1 ring-border">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[13px] font-bold text-text">
                        {chipKindLabel(run.kind, messages)} · {chip.name}
                      </h3>
                      <StatusPill value={run.status} />
                    </div>
                    <p className="mt-0.5 truncate text-[12px] text-text-secondary">
                      {contentSummary(chip, messages) || messages.workspace.notConfigured}
                    </p>
                    <p className="mt-1 text-[12px] font-medium tabular-nums text-text">
                      {metricLine(run, output, messages)}
                    </p>
                  </div>
                  {onViewLog && live ? (
                    <Button type="button" variant="quiet" onClick={() => onViewLog(live)}>
                      <ScrollText className="size-3.5" aria-hidden="true" />
                      {messages.chipRuns.viewLog}
                    </Button>
                  ) : null}
                </header>
                <div className="grid gap-3 p-3">
                  {run.error_message ? (
                    <p className={cn(
                      "rounded-xl px-3 py-2 text-xs",
                      run.status === "failed" ? "bg-danger-subtle text-danger" : "bg-subtle text-text-secondary",
                    )}>
                      {run.error_message}
                    </p>
                  ) : null}
                  <ChipDetailView chip={chip} inputFileName={input?.filename} />
                  {run.kind === "validation" ? <ValidationStats result={run.result} /> : null}
                  {run.kind === "load" ? <LoadStats result={run.result} /> : null}
                  {run.kind === "sql" ? <SqlStats result={run.result} /> : null}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </AppDialog>
  );
}

function contentSummary(chip: Chip, messages: Messages): string {
  if (chip.kind === "extract") {
    const extract = parseExtractConfig(chip.config);
    if (!extract) return "";
    if (extract.mode === "http") return `${extract.method} ${extract.path}`.trim();
    if (extract.mode === "query") return fmtSqlPreview(extract.sql);
    return [extract.database, extract.table].filter(Boolean).join(".") ;
  }
  if (chip.kind === "transform") {
    const transform = parseTransformConfig(chip.config);
    return transform ? messages.workspace.runReportTransformSteps(transform.steps.length) : "";
  }
  if (chip.kind === "load") {
    const load = parseLoadConfig(chip.config);
    if (!load) return "";
    return load.destinationType === "file" ? load.filename : load.table;
  }
  if (chip.kind === "sql") {
    return typeof chip.config.sql_text === "string" ? fmtSqlPreview(chip.config.sql_text) : "";
  }
  const keys = Array.isArray(chip.config.keys)
    ? chip.config.keys.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  return keys.join(", ");
}

function metricLine(run: ChipRun, output: Dataset | undefined, messages: Messages): string {
  const parts: string[] = [];
  const rows = run.kind === "load"
    ? numberField(run.result, "loaded_rows") ?? run.output_rows
    : run.kind === "sql"
      ? numberField(run.result, "row_count") ?? run.output_rows
      : run.output_rows ?? output?.row_count ?? null;
  if (run.kind === "validation") {
    const source = numberField(run.result, "source_rows") ?? run.input_rows;
    const target = numberField(run.result, "target_rows") ?? run.output_rows;
    if (source != null) parts.push(`${messages.validation.sourceRows} ${source.toLocaleString()}`);
    if (target != null) parts.push(`${messages.validation.targetRows} ${target.toLocaleString()}`);
  } else if (rows != null) {
    parts.push(messages.common.rows(rows));
  }
  const elapsed = numberField(run.result, "elapsed_ms")
    ?? numberField(run.result, "duration_ms")
    ?? runDurationMs(run.started_at, run.finished_at);
  if (elapsed != null) parts.push(messages.common.duration(elapsed));
  const filename = output?.filename || (typeof run.result?.filename === "string" ? run.result.filename : "");
  if (filename && (run.kind === "extract" || run.kind === "transform")) {
    parts.push(filename);
  }
  return parts.join(" · ") || "—";
}

function ValidationStats({ result }: { result?: Record<string, unknown> | null }) {
  const { messages } = useLanguage();
  const report = asValidationReport(result);
  if (!report) return null;
  const t = messages.validation;
  return (
    <section className="grid gap-3">
      <div className={report.passed ? "rounded-xl bg-success-subtle p-3 text-sm font-bold text-success" : "rounded-xl bg-danger-subtle p-3 text-sm font-bold text-danger"}>
        {report.passed ? t.passed : t.failed}
      </div>
      <dl className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
        {([
          [t.sourceRows, report.source_rows],
          [t.targetRows, report.target_rows],
          [t.missing, report.missing_keys],
          [t.extra, report.extra_keys],
          [t.mismatch, report.mismatched_rows],
          [t.sourceDuplicates, report.duplicate_source_keys],
          [t.targetDuplicates, report.duplicate_target_keys],
          [messages.workspace.runReportSchemaMatch, report.schema_matches ? messages.common.yes : messages.common.no],
        ] as const).map(([label, value]) => (
          <div key={String(label)} className="rounded-lg border border-border p-3">
            <dt className="text-[11px] text-text-tertiary">{label}</dt>
            <dd className="mt-1 font-bold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {report.samples.length ? (
        <div className="grid gap-1.5">
          <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-text-tertiary">{messages.workspace.runReportSamples}</p>
          <pre className="scroll-pane max-h-48 overflow-auto rounded-xl bg-workspace p-3 text-xs text-white">
            {report.samples.join("\n")}
          </pre>
        </div>
      ) : null}
    </section>
  );
}

function LoadStats({ result }: { result?: Record<string, unknown> | null }) {
  const { messages } = useLanguage();
  if (!result) return null;
  const destination = textField(result, "destination");
  const mode = textField(result, "write_mode");
  const modeLabel = mode === "append" ? messages.load.append
    : mode === "replace" ? messages.load.replace
    : mode === "truncate" ? messages.load.truncate
    : mode === "upsert" ? messages.load.upsert
    : mode === "recreate" ? messages.load.recreate
    : mode;
  const loaded = numberField(result, "loaded_rows");
  const input = numberField(result, "input_rows");
  const rejected = numberField(result, "rejected_rows");
  const bytes = numberField(result, "input_bytes");
  const items = [
    destination ? [messages.load.lastRunDestination, destination] : null,
    modeLabel ? [messages.load.writeMode, modeLabel] : null,
    loaded != null ? [messages.load.lastRunRows, loaded.toLocaleString()] : null,
    input != null ? [messages.load.lastRunInput, input.toLocaleString()] : null,
    rejected != null && rejected > 0 ? [messages.workspace.runReportRejected, rejected.toLocaleString()] : null,
    bytes != null ? [messages.workspace.runReportSize, fmtBytes(bytes)] : null,
  ].filter((item): item is [string, string] => Boolean(item));
  if (items.length === 0) return null;
  return (
    <dl className="grid grid-cols-2 gap-2 text-sm md:grid-cols-3">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-lg border border-border p-3">
          <dt className="text-[11px] text-text-tertiary">{label}</dt>
          <dd className="mt-1 break-all font-bold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SqlStats({ result }: { result?: Record<string, unknown> | null }) {
  const { messages } = useLanguage();
  if (!result) return null;
  const kind = textField(result, "kind");
  const rows = numberField(result, "row_count");
  const truncated = result.truncated === true;
  const items = [
    kind ? [messages.workspace.runReportSqlKind, kind === "rows" ? messages.workspace.runReportSqlSelect : messages.workspace.runReportSqlExec] : null,
    rows != null ? [messages.workspace.runReportRows, rows.toLocaleString()] : null,
    truncated ? [messages.workspace.runReportTruncated, messages.common.yes] : null,
  ].filter((item): item is [string, string] => Boolean(item));
  if (items.length === 0) return null;
  return (
    <dl className="grid grid-cols-2 gap-2 text-sm md:grid-cols-3">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-lg border border-border p-3">
          <dt className="text-[11px] text-text-tertiary">{label}</dt>
          <dd className="mt-1 font-bold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function numberField(record: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textField(record: Record<string, unknown> | null | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function asValidationReport(result?: Record<string, unknown> | null): ValidationReport | null {
  if (!result || typeof result.passed !== "boolean") return null;
  const samples = Array.isArray(result.samples)
    ? result.samples.filter((item): item is string => typeof item === "string")
    : [];
  return {
    passed: result.passed,
    source_rows: numberField(result, "source_rows") ?? 0,
    target_rows: numberField(result, "target_rows") ?? 0,
    missing_keys: numberField(result, "missing_keys") ?? 0,
    extra_keys: numberField(result, "extra_keys") ?? 0,
    duplicate_source_keys: numberField(result, "duplicate_source_keys") ?? 0,
    duplicate_target_keys: numberField(result, "duplicate_target_keys") ?? 0,
    mismatched_rows: numberField(result, "mismatched_rows") ?? 0,
    schema_matches: result.schema_matches !== false,
    samples,
  };
}
