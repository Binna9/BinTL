import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import {
  bindingKindLabel,
  formatTransformStepSummary,
  parseExtractConfig,
  parseTransformConfig,
  supportsReadableDetail,
} from "@/lib/chipDetail";
import { connectionApi } from "@/services/connections/connectionApi";
import { datasetApi } from "@/services/transform/datasetApi";
import type { Chip } from "@/types/chip";
import type { StepOp } from "@/types/transform";

function DetailRow({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">{label}</dt>
      <dd className="mt-1 text-[13px] text-text">{children}</dd>
    </div>
  );
}

export function ChipDetailView({ chip }: { chip: Chip }) {
  const { messages } = useLanguage();
  const [connectionName, setConnectionName] = useState("");
  const [datasetName, setDatasetName] = useState("");

  const extract = chip.kind === "extract" ? parseExtractConfig(chip.config) : null;
  const transform = chip.kind === "transform" ? parseTransformConfig(chip.config) : null;

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
    const connectionId = extract?.connectionId ?? "";
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
  }, [extract?.connectionId]);

  useEffect(() => {
    let cancelled = false;
    const datasetId = transform?.inputDatasetId ?? "";
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
  }, [transform?.inputDatasetId]);

  if (chip.kind === "load") {
    return <p className="text-sm text-text-secondary">{messages.workspace.loadUnavailable}</p>;
  }

  if (!supportsReadableDetail(chip.kind)) {
    return <p className="text-sm text-text-secondary">{messages.chips.detailEmpty}</p>;
  }

  if (chip.kind === "extract" && extract) {
    const unset = messages.chips.detailUnset;
    return (
      <dl className="grid gap-4">
        {chip.binding ? (
          <DetailRow label={messages.chips.binding}>
            {bindingKindLabel(chip.binding.ref_kind, messages)}
          </DetailRow>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
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
          <DetailRow label={messages.common.delimiter}>{extract.delimiter || ","}</DetailRow>
          <DetailRow label={messages.workspace.hasHeader}>
            {extract.header ? messages.common.yes : messages.common.no}
          </DetailRow>
        </div>
        {extract.mode === "http" ? (
          <div className="grid grid-cols-2 gap-3">
            <DetailRow label={messages.apiExtract.method}>{extract.method || "GET"}</DetailRow>
            <DetailRow label={messages.apiExtract.path}>{extract.path || unset}</DetailRow>
            <DetailRow label={messages.apiExtract.recordsPath}>
              {extract.recordsPath || "—"}
            </DetailRow>
          </div>
        ) : extract.mode === "table" ? (
          <div className="grid grid-cols-2 gap-3">
            <DetailRow label={messages.workspace.table}>{extract.table || unset}</DetailRow>
            <DetailRow label={messages.workspace.database}>{extract.database || "—"}</DetailRow>
          </div>
        ) : (
          <DetailRow label={messages.workspace.sql}>
            <pre className="scroll-pane max-h-56 overflow-auto rounded-lg border border-border bg-subtle/40 p-3 font-mono text-[12px] leading-relaxed text-text">
              {extract.sql.trim() || unset}
            </pre>
          </DetailRow>
        )}
      </dl>
    );
  }

  if (chip.kind === "transform" && transform) {
    return (
      <dl className="grid gap-4">
        {chip.binding ? (
          <DetailRow label={messages.chips.binding}>
            {bindingKindLabel(chip.binding.ref_kind, messages)}
          </DetailRow>
        ) : null}
        <DetailRow label={messages.workspace.inputDataset}>
          {datasetName || transform.inputDatasetId || messages.chips.detailUnset}
        </DetailRow>
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
            {messages.transform.steps}
          </dt>
          <dd className="mt-2">
            {transform.steps.length === 0 ? (
              <p className="text-sm text-text-secondary">{messages.empty.steps}</p>
            ) : (
              <ol className="space-y-2">
                {transform.steps.map((step, index) => (
                  <li
                    key={`${step.op}-${index}`}
                    className="rounded-lg border border-border bg-subtle/30 px-3 py-2.5"
                  >
                    <p className="text-xs font-semibold uppercase tracking-[0.06em] text-text">
                      {index + 1}. {stepLabels[step.op]}
                    </p>
                    <p className={cn("mt-1 text-[13px] leading-relaxed text-text-secondary", step.op === "filter" && "font-mono text-[12px]")}>
                      {formatTransformStepSummary(step)}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </dd>
        </div>
      </dl>
    );
  }

  return <p className="text-sm text-text-secondary">{messages.chips.detailEmpty}</p>;
}
