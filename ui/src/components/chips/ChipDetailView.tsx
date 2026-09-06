import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Braces, Database, FileInput, FileOutput, Layers3, Link2, Settings2, ShieldCheck, Workflow, type LucideIcon } from "lucide-react";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import {
  bindingKindLabel,
  formatTransformStepSummary,
  parseExtractConfig,
  parseLoadConfig,
  parseTransformConfig,
  supportsReadableDetail,
} from "@/lib/chipDetail";
import { connectionApi } from "@/services/connections/connectionApi";
import { datasetApi } from "@/services/transform/datasetApi";
import type { Chip } from "@/types/chip";
import type { StepOp } from "@/types/transform";

function DetailRow({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid min-h-11 grid-cols-[7.25rem_minmax(0,1fr)] items-center gap-3 border-b border-border/55 px-3.5 py-2.5 last:border-b-0", className)}>
      <dt className="text-[10px] font-bold uppercase tracking-[0.09em] text-text-tertiary">{label}</dt>
      <dd className="min-w-0 break-words text-right text-[13px] font-medium leading-5 text-text">{children}</dd>
    </div>
  );
}

function DetailSection({ icon: Icon, title, tone = "accent", children }: {
  icon: LucideIcon;
  title: string;
  tone?: "accent" | "success" | "warning";
  children: ReactNode;
}) {
  const toneClass = tone === "success"
    ? "bg-success-subtle text-success ring-success/15"
    : tone === "warning"
      ? "bg-warning-subtle text-warning ring-warning/15"
      : "bg-accent-subtle text-accent ring-accent/15";
  return (
    <section className="overflow-hidden rounded-2xl border border-border/80 bg-surface shadow-[0_10px_30px_rgba(15,23,42,0.045)]">
      <header className="flex items-center gap-2.5 border-b border-border/70 bg-gradient-to-r from-subtle/90 to-surface px-3.5 py-3">
        <span className={cn("grid size-7 shrink-0 place-items-center rounded-lg ring-1", toneClass)}>
          <Icon className="size-3.5" aria-hidden="true" />
        </span>
        <h3 className="text-[12px] font-bold tracking-[-0.01em] text-text">{title}</h3>
      </header>
      <dl>{children}</dl>
    </section>
  );
}

function DetailStack({ children }: { children: ReactNode }) {
  return <div className="grid gap-3">{children}</div>;
}

export function ChipDetailView({ chip, inputFileName }: { chip: Chip; inputFileName?: string }) {
  const { messages } = useLanguage();
  const [connectionName, setConnectionName] = useState("");
  const [datasetName, setDatasetName] = useState("");

  const extract = chip.kind === "extract" ? parseExtractConfig(chip.config) : null;
  const transform = chip.kind === "transform" ? parseTransformConfig(chip.config) : null;
  const load = chip.kind === "load" ? parseLoadConfig(chip.config) : null;

  const stepLabels = useMemo<Record<StepOp, string>>(
    () => ({
      select: messages.transform.opSelect,
      drop: messages.transform.opDrop,
      rename: messages.transform.opRename,
      filter: messages.transform.opFilter,
      cast: messages.transform.opCast,
      fill_null: messages.transform.opFillNull,
      sort: messages.transform.opSort,
      unique: messages.transform.opUnique,
    }),
    [messages],
  );

  useEffect(() => {
    let cancelled = false;
    const connectionId = extract?.connectionId ?? load?.connectionId ?? "";
    if (!connectionId) {
      setConnectionName("");
      return;
    }
    void connectionApi
      .getConnections()
      .then((response) => {
        if (cancelled) return;
        const match = response.connections.find((item) => item.id === connectionId);
        setConnectionName(match?.name ?? connectionId);
      })
      .catch(() => {
        if (!cancelled) setConnectionName(connectionId);
      });
    return () => {
      cancelled = true;
    };
  }, [extract?.connectionId, load?.connectionId]);

  useEffect(() => {
    let cancelled = false;
    const validationSourceId = chip.kind === "validation" && typeof chip.config.source_data_file_id === "string"
      ? chip.config.source_data_file_id
      : "";
    const datasetId = transform?.inputDatasetId ?? load?.inputDatasetId ?? validationSourceId;
    if (!datasetId) {
      setDatasetName("");
      return;
    }
    void datasetApi
      .list()
      .then((response) => {
        if (cancelled) return;
        const match = response.datasets.find((item) => item.id === datasetId);
        setDatasetName(match?.filename ?? datasetId);
      })
      .catch(() => {
        if (!cancelled) setDatasetName(datasetId);
      });
    return () => {
      cancelled = true;
    };
  }, [chip.config.source_data_file_id, chip.kind, load?.inputDatasetId, transform?.inputDatasetId]);

  if (chip.kind === "load") {
    const unset = messages.chips.detailUnset;
    return <DetailStack>
      <DetailSection icon={FileInput} title={messages.workspace.inputDataset}>
        <DetailRow label={messages.workspace.dataFileName}>{inputFileName || datasetName || load?.inputDatasetId || unset}</DetailRow>
        {chip.binding ? <DetailRow label={messages.chips.binding}>{bindingKindLabel(chip.binding.ref_kind, messages)}</DetailRow> : null}
      </DetailSection>
      <DetailSection icon={FileOutput} title={messages.load.destinationType} tone="warning">
        <DetailRow label={messages.load.destinationType}>{load ? (load.destinationType === "database" ? messages.load.database : messages.load.file) : messages.workspace.notConfigured}</DetailRow>
        {load?.destinationType === "database" ? <>
          <DetailRow label={messages.load.connection}>{connectionName || load.connectionId || unset}</DetailRow>
          <DetailRow label={messages.load.table}>{load.table || unset}</DetailRow>
        </> : load?.destinationType === "file" ? <>
          <DetailRow label={messages.load.format}>{load.format.toUpperCase() || unset}</DetailRow>
          <DetailRow label={messages.load.filename}>{load.filename || unset}</DetailRow>
        </> : <>
          <DetailRow label={messages.load.connection}>{unset}</DetailRow>
          <DetailRow label={messages.load.table}>{unset}</DetailRow>
        </>}
        <DetailRow label={messages.load.writeMode}>{load?.writeMode === "append" ? messages.load.append : load ? messages.load.replace : unset}</DetailRow>
      </DetailSection>
    </DetailStack>;
  }

  if (chip.kind === "validation") {
    const keys = Array.isArray(chip.config.keys)
      ? chip.config.keys.filter((value): value is string => typeof value === "string")
      : [];
    const columns = Array.isArray(chip.config.columns)
      ? chip.config.columns.filter((value): value is string => typeof value === "string")
      : [];
    return <DetailStack>
      <DetailSection icon={ShieldCheck} title={messages.workspace.placeValidationTitle}>
        <DetailRow label={messages.validation.source}>{datasetName || messages.chips.detailUnset}</DetailRow>
        <DetailRow label={messages.validation.target}>{inputFileName || messages.validation.targetFromCanvas}</DetailRow>
      </DetailSection>
      <DetailSection icon={Settings2} title={messages.validation.keys} tone="success">
        <DetailRow label={messages.validation.keys}>{keys.join(", ") || messages.chips.detailUnset}</DetailRow>
        <DetailRow label={messages.validation.columns}>{columns.join(", ") || messages.validation.columnsHint}</DetailRow>
      </DetailSection>
    </DetailStack>;
  }

  if (!supportsReadableDetail(chip.kind)) {
    return <p className="text-sm text-text-secondary">{messages.chips.detailEmpty}</p>;
  }

  if (chip.kind === "extract" && extract) {
    const unset = messages.chips.detailUnset;
    return (
      <DetailStack>
        <DetailSection icon={Database} title={messages.workspace.extractConfig}>
          {chip.binding ? (
            <DetailRow label={messages.chips.binding}>{bindingKindLabel(chip.binding.ref_kind, messages)}</DetailRow>
          ) : null}
          <DetailRow label={messages.workspace.connection}>
            {connectionName || extract.connectionId || unset}
          </DetailRow>
          <DetailRow label={messages.workspace.mode}>
            {extract.mode === "http"
              ? "HTTP"
              : extract.mode === "query"
                ? messages.workspace.queryMode
                : messages.workspace.tableMode}
          </DetailRow>
          <DetailRow label={messages.workspace.dataFileName}>
            {chip.output?.filename || extract.outputFilename || unset}
          </DetailRow>
          <DetailRow label={messages.common.delimiter}>{extract.delimiter || ","}</DetailRow>
          <DetailRow label={messages.workspace.hasHeader}>
            {extract.header ? messages.common.yes : messages.common.no}
          </DetailRow>
        </DetailSection>
        {extract.mode === "http" ? (
          <DetailSection icon={Link2} title={messages.apiExtract.path} tone="success">
            <DetailRow label={messages.apiExtract.method}>{extract.method || "GET"}</DetailRow>
            <DetailRow label={messages.apiExtract.path}>{extract.path || unset}</DetailRow>
            <DetailRow label={messages.apiExtract.recordsPath}>{extract.recordsPath || "—"}</DetailRow>
          </DetailSection>
        ) : extract.mode === "table" ? (
          <DetailSection icon={Layers3} title={messages.workspace.table} tone="success">
            <DetailRow label={messages.workspace.table}>{extract.table || unset}</DetailRow>
            <DetailRow label={messages.workspace.database}>{extract.database || "—"}</DetailRow>
          </DetailSection>
        ) : (
          <DetailSection icon={Braces} title={messages.workspace.sql} tone="success">
            <pre className="scroll-pane m-3 max-h-56 overflow-auto rounded-xl border border-border/70 bg-subtle/55 p-3 font-mono text-[12px] leading-relaxed text-text shadow-inner">
              {extract.sql.trim() || unset}
            </pre>
          </DetailSection>
        )}
      </DetailStack>
    );
  }

  if (chip.kind === "transform" && transform) {
    return (
      <DetailStack>
        <DetailSection icon={Workflow} title={messages.workspace.transformConfig} tone="success">
          <DetailRow label={messages.workspace.inputDataset}>{inputFileName || datasetName || transform.inputDatasetId || messages.chips.detailUnset}</DetailRow>
          <DetailRow label={messages.workspace.dataFileName}>{chip.output?.filename || messages.workspace.outputEmpty}</DetailRow>
          {chip.binding ? <DetailRow label={messages.chips.binding}>{bindingKindLabel(chip.binding.ref_kind, messages)}</DetailRow> : null}
        </DetailSection>
        <section className="overflow-hidden rounded-2xl border border-border/80 bg-surface shadow-[0_10px_30px_rgba(15,23,42,0.045)]">
          <header className="flex items-center gap-2.5 border-b border-border/70 bg-gradient-to-r from-success-subtle/70 to-surface px-3.5 py-3">
            <span className="grid size-7 place-items-center rounded-lg bg-success-subtle text-success ring-1 ring-success/15"><Layers3 className="size-3.5" /></span>
            <h3 className="text-[12px] font-bold text-text">{messages.transform.steps}</h3>
            <span className="ml-auto rounded-full bg-success-subtle px-2 py-0.5 text-[10px] font-bold tabular-nums text-success">{transform.steps.length}</span>
          </header>
          <div className="p-3">
            {transform.steps.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-text-tertiary">{messages.empty.steps}</p>
            ) : (
              <ol className="relative space-y-2 before:absolute before:bottom-4 before:left-[0.8125rem] before:top-4 before:w-px before:bg-border">
                {transform.steps.map((step, index) => (
                  <li
                    key={`${step.op}-${index}`}
                    className="relative grid grid-cols-[1.625rem_minmax(0,1fr)] gap-2.5 rounded-xl border border-border/70 bg-subtle/30 p-2.5 shadow-sm"
                  >
                    <span className="relative z-10 grid size-[1.625rem] place-items-center rounded-full bg-surface text-[10px] font-bold text-success ring-1 ring-border">{index + 1}</span>
                    <div className="min-w-0">
                      <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-text">{stepLabels[step.op]}</p>
                      <p className={cn("mt-0.5 break-words text-[12px] leading-relaxed text-text-secondary", step.op === "filter" && "font-mono text-[11px]")}>{formatTransformStepSummary(step)}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
      </DetailStack>
    );
  }

  return <p className="text-sm text-text-secondary">{messages.chips.detailEmpty}</p>;
}
