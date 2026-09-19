import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useNavigate } from "react-router-dom";
import {
  Braces,
  Check,
  ChevronRight,
  Cloud,
  Database,
  DatabaseZap,
  FileSpreadsheet,
  FileOutput,
  FileStack,
  Globe,
  Layers3,
  Plus,
  Terminal,
  Search,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { emptyKindSearch, KIND_APPEARANCE, KIND_ORDER } from "@/features/transform/transformEditorModel";
import { MAX_SCRIPT_INPUTS } from "@/features/script/scriptEditorModel";
import { chipKindLabel, incomingDataChipId, producerChips, validationTargetChips } from "@/features/workspace/workspaceCanvasModel";
import type { Messages } from "@/i18n/ko";
import { cn } from "@/lib/cn";
import { fmtBytes } from "@/lib/format";
import { selectableClass } from "@/lib/selectable";
import { slugFromName, newServeApiKey } from "@/components/workspace/ServeChipEditorDialog";
import type { Chip, ChipEdge } from "@/types/chip";
import type { Dataset } from "@/types/dataset";

export type ChipPlaceKind = "extract" | "transform" | "load" | "validation" | "sql" | "serve" | "script";

export type TransformPlaceDraft = {
  name: string;
  inputDatasetId: string;
  inputDatasetIds?: string[];
  inputChipId?: string;
  inputChipIds?: string[];
};

export type EmptyConsumerDraft = {
  name: string;
  inputChipId?: string;
  inputChipIds?: string[];
  sourceChipId?: string;
  targetChipId?: string;
  slug?: string;
  apiKey?: string;
  freshness?: "slot" | "live";
};

const PRODUCER_KIND_ORDER = ["extract", "transform", "script", "load"] as const;
type ProducerSelectKind = (typeof PRODUCER_KIND_ORDER)[number];

const PRODUCER_KIND_APPEARANCE = {
  extract: {
    icon: DatabaseZap,
    frame: "border-accent/25",
    header: "bg-accent-subtle text-accent",
    count: "bg-accent/15 text-accent",
    iconWrap: "bg-accent-subtle text-accent ring-1 ring-inset ring-accent/20",
  },
  transform: {
    icon: Workflow,
    frame: "border-success/25",
    header: "bg-success-subtle text-success",
    count: "bg-success/15 text-success",
    iconWrap: "bg-success-subtle text-success ring-1 ring-inset ring-success/20",
  },
  script: {
    icon: Braces,
    frame: "border-amber-500/25",
    header: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    count: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    iconWrap: "bg-amber-500/10 text-amber-700 ring-1 ring-inset ring-amber-500/20 dark:text-amber-400",
  },
  load: {
    icon: FileOutput,
    frame: "border-warning/25",
    header: "bg-warning-subtle text-warning",
    count: "bg-warning/15 text-warning",
    iconWrap: "bg-warning-subtle text-warning ring-1 ring-inset ring-warning/20",
  },
} as const;

const EMPTY_NAME_DIALOG_CLASS = "flex max-h-[min(32rem,86vh)] w-[min(24rem,calc(100vw-1.5rem))] min-w-0 max-w-full";
const VALIDATION_NAME_DIALOG_CLASS = "flex max-h-[min(86vh,48rem)] w-[min(40rem,calc(100vw-1.5rem))] min-w-0 max-w-full";

export function CanvasProducerSelect({
  chips,
  value,
  values,
  excludeIds,
  messages,
  label,
  disabled,
  kinds,
  max,
  onChange,
  onValuesChange,
}: {
  chips: Chip[];
  value?: string;
  values?: string[];
  excludeIds?: Iterable<string>;
  messages: Messages;
  label: string;
  disabled?: boolean;
  kinds?: readonly ProducerSelectKind[];
  max?: number;
  onChange?: (id: string) => void;
  onValuesChange?: (ids: string[]) => void;
}) {
  const skip = useMemo(() => new Set(excludeIds ?? []), [excludeIds]);
  const allowed = kinds ?? (["extract", "transform", "script"] as const);
  const options = useMemo(() => {
    const listed = allowed.includes("load") ? validationTargetChips(chips) : producerChips(chips);
    return listed.filter((chip) => allowed.includes(chip.kind as ProducerSelectKind));
  }, [allowed, chips]);
  const grouped = useMemo(
    () =>
      PRODUCER_KIND_ORDER.filter((kind) => allowed.includes(kind)).map((kind) => ({
        kind,
        items: options.filter((chip) => chip.kind === kind),
      })),
    [allowed, options],
  );
  const selected = values ?? (value ? [value] : []);
  const multi = Boolean(onValuesChange);

  return (
    <div className="flex min-w-0 shrink-0 flex-col gap-2">
      <span className="text-xs font-semibold text-text">{label}</span>
      <div
        className={cn("flex min-w-0 flex-col gap-2", disabled && "pointer-events-none opacity-50")}
        role="listbox"
        aria-label={label}
        aria-disabled={disabled}
        aria-multiselectable={multi || undefined}
      >
        {grouped.map((group) => {
          const appearance = PRODUCER_KIND_APPEARANCE[group.kind];
          const KindIcon = appearance.icon;
          const kindName = chipKindLabel(group.kind, messages);
          return (
            <section
              key={group.kind}
              className={cn("min-w-0 overflow-hidden rounded-lg border bg-surface", appearance.frame)}
            >
              <div className={cn("flex min-w-0 items-center gap-1.5 px-2 py-1.5", appearance.header)}>
                <KindIcon className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[11px] font-bold">{kindName}</span>
                <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums", appearance.count)}>
                  {group.items.length}
                </span>
              </div>
              {group.items.length === 0 ? (
                <p className="px-2 py-2 text-[11px] leading-4 text-text-tertiary">
                  {messages.workspace.noKindOnCanvas(kindName)}
                </p>
              ) : (
                <ul className="scroll-pane m-0 max-h-36 list-none overflow-y-auto overflow-x-hidden p-0">
                  {group.items.map((chip) => {
                    const picked = selected.includes(chip.id);
                    const blocked = skip.has(chip.id);
                    const full = Boolean(max && !picked && selected.length >= max);
                    return (
                      <li key={chip.id} className="min-w-0 border-t border-border/70">
                        <button
                          type="button"
                          role="option"
                          aria-selected={picked}
                          disabled={disabled || blocked || full}
                          className={cn(
                            "flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left outline-none",
                            selectableClass(picked),
                            (blocked || full) && "opacity-50",
                          )}
                          onClick={() => {
                            if (multi) {
                              onValuesChange?.(
                                picked
                                  ? selected.filter((id) => id !== chip.id)
                                  : [...selected, chip.id],
                              );
                              return;
                            }
                            onChange?.(picked ? "" : chip.id);
                          }}
                        >
                          <span className={cn("grid size-6 shrink-0 place-items-center rounded-md", appearance.iconWrap)}>
                            <KindIcon className="size-3.5" aria-hidden="true" />
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text">{chip.name}</span>
                          {picked ? <Check className="size-3.5 shrink-0 text-accent" aria-hidden="true" /> : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}


function CatalogChipPanel({
  kind,
  chips,
  canvasChipIds,
  messages,
  selectedIds,
  onSelectedIdsChange,
  className,
}: {
  kind: ChipPlaceKind;
  chips: Chip[];
  canvasChipIds: Set<string>;
  messages: Messages;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const options = useMemo(() => chips.filter((chip) => chip.kind === kind), [chips, kind]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((chip) => chip.name.toLowerCase().includes(needle));
  }, [options, query]);
  const RowIcon = kind === "extract" ? DatabaseZap : kind === "transform" ? Workflow : kind === "validation" ? ShieldCheck : kind === "sql" ? Terminal : kind === "serve" ? Globe : kind === "script" ? Braces : FileOutput;
  const iconClassName = kind === "extract" ? "text-accent" : kind === "transform" ? "text-success" : kind === "validation" ? "text-violet-600 dark:text-violet-400" : kind === "sql" ? "text-sky-600 dark:text-sky-400" : kind === "serve" ? "text-teal-600 dark:text-teal-400" : kind === "script" ? "text-amber-600 dark:text-amber-400" : "text-warning";
  const emptyHint = kind === "extract"
    ? messages.workspace.emptyCatalogExtract
    : kind === "transform" ? messages.workspace.emptyCatalogTransform
      : kind === "validation" ? messages.workspace.emptyCatalogValidation
        : kind === "sql" ? messages.workspace.emptyCatalogSql
          : kind === "serve" ? messages.workspace.emptyCatalogServe
            : kind === "script" ? messages.workspace.emptyCatalogScript : messages.workspace.emptyCatalogLoad;

  if (options.length === 0) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-4 py-8">
        <p className="text-center text-xs leading-5 text-text-tertiary">{emptyHint}</p>
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-2", className)}>
      <div className="group flex h-9 shrink-0 items-center overflow-hidden rounded-lg border border-border bg-subtle/40 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
        <span className="grid h-full w-9 shrink-0 place-items-center border-r border-border bg-subtle text-text-tertiary group-focus-within:text-accent">
          <Search className="size-3.5" aria-hidden="true" />
        </span>
        <input
          type="search"
          className="min-w-0 flex-1 bg-transparent px-3 text-xs text-text outline-none placeholder:text-text-tertiary"
          value={query}
          placeholder={messages.workspace.pickChipSearch}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <ul className="m-0 min-h-0 flex-1 list-none divide-y divide-border/50 overflow-y-auto overscroll-contain rounded-lg border border-border/60 p-0">
        {filtered.map((chip) => {
          const placed = canvasChipIds.has(chip.id);
          const selected = !placed && selectedIds.includes(chip.id);
          return (
            <li key={chip.id}>
              <button
                type="button"
                disabled={placed}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none",
                  placed ? "cursor-not-allowed opacity-50" : selected ? "bg-accent-subtle/80" : "hover:bg-subtle/70",
                )}
                aria-pressed={selected}
                onClick={() =>
                  onSelectedIdsChange(
                    selected
                      ? selectedIds.filter((id) => id !== chip.id)
                      : [...selectedIds, chip.id],
                  )
                }
              >
                <span
                  className={cn(
                    "grid size-4 shrink-0 place-items-center rounded border",
                    selected ? "border-accent bg-accent text-white" : "border-border text-transparent",
                  )}
                >
                  <Check className="size-3" />
                </span>
                <RowIcon className={cn("size-4 shrink-0", iconClassName)} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{chip.name}</span>
                {placed ? (
                  <span className="shrink-0 text-[11px] text-text-tertiary">{messages.workspace.chipOnCanvas}</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PlaceDialogFooter({
  cancelLabel,
  submitLabel,
  canSubmit,
  busy,
  onCancel,
  onSubmit,
}: {
  cancelLabel: string;
  submitLabel: string;
  canSubmit: boolean;
  busy?: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="chip-place-foot">
      <Button type="button" variant="secondary" onClick={onCancel}>
        {cancelLabel}
      </Button>
      <Button type="button" variant="secondary" disabled={busy || !canSubmit} onClick={onSubmit}>
        {submitLabel}
      </Button>
    </div>
  );
}

function DatasetPickerPanel({
  title,
  datasets,
  selectedId,
  selectedIds,
  emptyLabel,
  messages,
  onPick,
  className,
}: {
  title: string;
  datasets: Dataset[];
  selectedId?: string;
  selectedIds?: string[];
  emptyLabel: string;
  messages: Messages;
  onPick: (dataset: Dataset) => void;
  className?: string;
}) {
  const [expandedKinds, setExpandedKinds] = useState<Set<(typeof KIND_ORDER)[number]>>(() => new Set());
  const [kindSearch, setKindSearch] = useState(emptyKindSearch);

  const kindLabel: Record<(typeof KIND_ORDER)[number], string> = {
    upload: messages.transform.kindUpload,
    database: messages.transform.kindDatabase,
    api: messages.transform.kindApi,
    transform: messages.transform.kindTransform,
    script: messages.transform.kindScript,
  };

  const grouped = useMemo(
    () => KIND_ORDER
      .map((kind) => ({ kind, items: datasets.filter((item) => item.kind === kind) }))
      .filter((group) => group.items.length > 0),
    [datasets],
  );
  const pickedIds = selectedIds ?? (selectedId ? [selectedId] : []);

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-2", className)} aria-label={title}>
      <div className="flex shrink-0 items-center gap-2">
        <FileStack className="size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.06em] text-text">
          {title}
        </span>
        <span className="shrink-0 rounded-full border border-border bg-surface px-1.5 py-0.5 text-[10px] tabular-nums text-text-tertiary">
          {messages.common.count(datasets.length)}
        </span>
      </div>
      <div className="scroll-pane min-h-0 flex-1 overflow-y-auto">
        {grouped.length === 0 ? (
          <p className="px-1 py-4 text-[12px] text-text-tertiary">{emptyLabel}</p>
        ) : (
          <div className="space-y-2 p-0.5">
            {grouped.map((group) => {
              const appearance = KIND_APPEARANCE[group.kind];
              const KindIcon = appearance.icon;
              const expanded = expandedKinds.has(group.kind);
              const query = kindSearch[group.kind].trim().toLocaleLowerCase();
              const visibleItems = query
                ? group.items.filter((item) =>
                    item.filename.toLocaleLowerCase().includes(query),
                  )
                : group.items;
              return (
                <section
                  key={group.kind}
                  className="overflow-hidden rounded-lg border border-border bg-surface"
                >
                  <button
                    type="button"
                    aria-expanded={expanded}
                    className={cn(
                      "flex w-full items-center gap-2 px-2.5 py-2 text-left transition-[filter] hover:brightness-95",
                      expanded && "border-b",
                      appearance.header,
                    )}
                    onClick={() =>
                      setExpandedKinds((current) => {
                        const next = new Set(current);
                        if (expanded) next.delete(group.kind);
                        else next.add(group.kind);
                        return next;
                      })
                    }
                  >
                    <KindIcon className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1 text-[12px] font-bold">
                      {kindLabel[group.kind]}
                    </span>
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums",
                        appearance.count,
                      )}
                    >
                      {group.items.length}
                    </span>
                    <ChevronRight
                      className={cn(
                        "size-3.5 shrink-0 transition-transform",
                        expanded && "rotate-90",
                      )}
                      aria-hidden="true"
                    />
                  </button>
                  {expanded ? (
                    <div className="border-b border-border bg-raised p-2">
                      <div className="group flex h-8 items-center overflow-hidden rounded-lg border border-border bg-surface shadow-sm transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
                        <span className="grid h-full w-8 shrink-0 place-items-center border-r border-border bg-subtle text-text-tertiary transition-colors group-focus-within:text-accent">
                          <Search className="size-3.5" aria-hidden="true" />
                        </span>
                        <input
                          type="search"
                          className="min-w-0 flex-1 bg-transparent px-2 text-[12px] text-text outline-none placeholder:text-text-tertiary"
                          value={kindSearch[group.kind]}
                          placeholder={messages.transform.searchFiles}
                          aria-label={`${kindLabel[group.kind]} ${messages.transform.searchFiles}`}
                          onChange={(event) =>
                            setKindSearch((current) => ({
                              ...current,
                              [group.kind]: event.target.value,
                            }))
                          }
                        />
                      </div>
                    </div>
                  ) : null}
                  {expanded && visibleItems.length === 0 ? (
                    <p className="px-2 py-3 text-center text-[11px] text-text-tertiary">
                      {messages.transform.noMatchingFiles}
                    </p>
                  ) : null}
                  {expanded
                    ? visibleItems.map((item) => {
                        const picked = pickedIds.includes(item.id);
                        return (
                        <button
                          key={item.id}
                          type="button"
                          className={cn(
                            "flex w-full min-w-0 items-start gap-2 border-b border-border px-2.5 py-2 text-left last:border-b-0",
                            selectableClass(picked),
                          )}
                          onClick={() => onPick(item)}
                        >
                          <FileSpreadsheet
                            className="mt-0.5 size-3.5 shrink-0 text-text-tertiary"
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block break-all text-[12px] font-medium leading-4">
                              {item.filename}
                              {!item.available && item.status !== "connected" ? (
                                <span className="ml-1 text-[10px] font-normal text-warning">
                                  ({messages.transform.sourceUnavailable})
                                </span>
                              ) : null}
                            </span>
                            <span className="mt-0.5 block truncate text-[10px] text-text-tertiary">
                              {item.origin?.connection_name
                                ? `${item.origin.connection_name} · ${item.origin.table_name}`
                                : item.size_bytes != null
                                  ? fmtBytes(item.size_bytes)
                                  : item.row_count != null
                                    ? messages.common.rows(item.row_count)
                                    : item.id.slice(0, 8)}
                            </span>
                          </span>
                          {picked ? <Check className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden="true" /> : null}
                        </button>
                        );
                      })
                    : null}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function PlacePanelHeader({
  icon,
  iconClassName,
  title,
  hint,
  dragHandleRef,
}: {
  icon: ReactNode;
  iconClassName: string;
  title: string;
  hint?: string;
  dragHandleRef?: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div ref={dragHandleRef} className="chip-place-head cursor-move select-none">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", iconClassName)}>
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text">{title}</h2>
          {hint ? <p className="text-[11px] text-text-tertiary">{hint}</p> : null}
        </div>
      </div>
    </div>
  );
}

function ExtractNewPanel({
  messages,
  busy,
  onClose,
  onPlaceCatalog,
  onRegisterDb,
  onRegisterApi,
  catalogChips,
  canvasChipIds,
  dragHandleRef,
}: {
  messages: Messages;
  busy?: boolean;
  onClose: () => void;
  onPlaceCatalog: (chipIds: string[]) => void;
  onRegisterDb: () => void;
  onRegisterApi: () => void;
  catalogChips: Chip[];
  canvasChipIds: Set<string>;
  dragHandleRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const [catalogSelectedIds, setCatalogSelectedIds] = useState<string[]>([]);
  const catalogCanSubmit = catalogSelectedIds.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PlacePanelHeader
        icon={<DatabaseZap className="size-4" aria-hidden="true" />}
        iconClassName="bg-accent-subtle text-accent"
        title={messages.workspace.placeExtractTitle}
        hint={messages.workspace.placeExtractSimpleHint}
        dragHandleRef={dragHandleRef}
      />

      <div className="grid shrink-0 grid-cols-2 gap-2 px-4 pt-4">
        <Button
          type="button"
          variant="secondary"
          className="h-10 gap-1.5 text-[12px]"
          onClick={onRegisterDb}
        >
          <Database className="size-3.5" aria-hidden="true" />
          {messages.workspace.placeExtractDbNew}
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="h-10 gap-1.5 text-[12px]"
          onClick={onRegisterApi}
        >
          <Cloud className="size-3.5" aria-hidden="true" />
          {messages.workspace.placeExtractApiNew}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-2 pt-4">
        <p className="shrink-0 text-[11px] text-text-tertiary">
          {messages.workspace.placeExtractCatalogHint}
        </p>
        <CatalogChipPanel
          kind="extract"
          chips={catalogChips}
          canvasChipIds={canvasChipIds}
          messages={messages}
          selectedIds={catalogSelectedIds}
          onSelectedIdsChange={setCatalogSelectedIds}
        />
      </div>

      <PlaceDialogFooter
        cancelLabel={messages.common.cancel}
        submitLabel={messages.workspace.pickChipPlace}
        canSubmit={catalogCanSubmit}
        busy={busy}
        onCancel={onClose}
        onSubmit={() => {
          if (!catalogCanSubmit) return;
          onPlaceCatalog(catalogSelectedIds);
        }}
      />
    </div>
  );
}

function TransformNewPanel({
  kind = "transform",
  datasets,
  defaultName,
  messages,
  busy,
  onClose,
  onPlaceEmpty,
  onPlaceDataset,
  onPlaceCatalog,
  catalogChips,
  canvasChips,
  canvasChipIds,
  dragHandleRef,
}: {
  kind?: "transform" | "script";
  datasets: Dataset[];
  defaultName: string;
  messages: Messages;
  busy?: boolean;
  onClose: () => void;
  onPlaceEmpty: (draft: EmptyConsumerDraft) => void;
  onPlaceDataset: (draft: TransformPlaceDraft) => void;
  onPlaceCatalog: (chipIds: string[]) => void;
  catalogChips: Chip[];
  canvasChips: Chip[];
  canvasChipIds: Set<string>;
  dragHandleRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const script = kind === "script";
  const [pickingDataset, setPickingDataset] = useState(false);
  const [namingEmpty, setNamingEmpty] = useState(false);
  const [emptyName, setEmptyName] = useState(defaultName);
  const [inputChipId, setInputChipId] = useState("");
  const [inputChipIds, setInputChipIds] = useState<string[]>([]);
  const [inputDatasetId, setInputDatasetId] = useState("");
  const [inputDatasetIds, setInputDatasetIds] = useState<string[]>([]);
  const [catalogSelectedIds, setCatalogSelectedIds] = useState<string[]>([]);

  const inputDatasets = useMemo(
    () => datasets.filter((dataset) =>
      dataset.kind === "upload"
      || dataset.kind === "database"
      || dataset.kind === "api"
      || dataset.kind === "script"
      || (script && dataset.kind === "transform")),
    [datasets, script],
  );

  useEffect(() => {
    setPickingDataset(false);
    setNamingEmpty(false);
    setEmptyName(defaultName);
    setInputChipId("");
    setInputChipIds([]);
    setInputDatasetId("");
    setInputDatasetIds([]);
    setCatalogSelectedIds([]);
  }, [defaultName]);

  const catalogCanSubmit = catalogSelectedIds.length > 0;
  const datasetCanSubmit = script ? inputDatasetIds.length > 0 : Boolean(inputDatasetId);
  const emptyInputReady = script ? inputChipIds.length > 0 : Boolean(inputChipId);

  function exitDatasetPick() {
    setPickingDataset(false);
    setInputDatasetId("");
    setInputDatasetIds([]);
  }

  const main = (
    <div className="chip-place-main">
      <PlacePanelHeader
        icon={script
          ? <Braces className="size-4" aria-hidden="true" />
          : <Workflow className="size-4" aria-hidden="true" />}
        iconClassName={script ? "bg-amber-500/10 text-amber-600 dark:text-amber-400" : "bg-success-subtle text-success"}
        title={script ? messages.workspace.placeScriptTitle : messages.workspace.placeTransformTitle}
        hint={script ? messages.workspace.placeScriptSimpleHint : messages.workspace.placeTransformSimpleHint}
        dragHandleRef={dragHandleRef}
      />

      <div className="grid shrink-0 grid-cols-2 gap-2 px-4 pt-4">
        <Button
          type="button"
          variant="secondary"
          aria-pressed={namingEmpty}
          className={cn(
            "h-10 gap-1.5 text-[12px]",
            namingEmpty && "border-accent bg-accent-subtle text-accent",
          )}
          disabled={busy || pickingDataset}
          onClick={() => {
            if (pickingDataset) exitDatasetPick();
            setEmptyName(defaultName);
            setInputChipId("");
            setInputChipIds([]);
            setNamingEmpty(true);
          }}
        >
          <Layers3 className="size-3.5" aria-hidden="true" />
          {script ? messages.workspace.placeScriptEmptyChip : messages.workspace.placeTransformEmptyChip}
        </Button>
        <Button
          type="button"
          variant={pickingDataset ? "primary" : "secondary"}
          aria-pressed={pickingDataset}
          data-state={pickingDataset ? "active" : "inactive"}
          className={cn(
            "h-10 gap-1.5 text-[12px]",
            pickingDataset && "ring-2 ring-accent/25",
          )}
          disabled={busy}
          onClick={() => {
            setNamingEmpty(false);
            if (pickingDataset) {
              exitDatasetPick();
              return;
            }
            setPickingDataset(true);
            setCatalogSelectedIds([]);
          }}
        >
          <FileStack className="size-3.5" aria-hidden="true" />
          {script ? messages.workspace.placeScriptFromDataset : messages.workspace.placeTransformFromDataset}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-2 pt-4">
        {pickingDataset ? (
          <>
            <p className="shrink-0 text-[11px] text-text-tertiary">
              {script ? messages.workspace.placeScriptDatasetHint : messages.workspace.placeTransformDatasetHint}
            </p>
            <DatasetPickerPanel
              title={script ? messages.workspace.inputDataset : messages.workspace.placeTransformInputDataset}
              datasets={inputDatasets}
              selectedId={script ? undefined : inputDatasetId}
              selectedIds={script ? inputDatasetIds : undefined}
              emptyLabel={messages.workspace.placeExtractFileEmpty}
              messages={messages}
              onPick={(dataset) => {
                if (!script) {
                  setInputDatasetId(dataset.id);
                  return;
                }
                setInputDatasetIds((current) => {
                  if (current.includes(dataset.id)) return current.filter((id) => id !== dataset.id);
                  if (current.length >= MAX_SCRIPT_INPUTS) return current;
                  return [...current, dataset.id];
                });
              }}
            />
          </>
        ) : (
          <>
            <p className="shrink-0 text-[11px] text-text-tertiary">
              {script ? messages.workspace.placeScriptCatalogHint : messages.workspace.placeTransformCatalogHint}
            </p>
            <CatalogChipPanel
              kind={kind}
              chips={catalogChips}
              canvasChipIds={canvasChipIds}
              messages={messages}
              selectedIds={catalogSelectedIds}
              onSelectedIdsChange={setCatalogSelectedIds}
            />
          </>
        )}
      </div>

      <PlaceDialogFooter
        cancelLabel={messages.common.cancel}
        submitLabel={
          pickingDataset
            ? (script ? messages.workspace.placeScriptContinue : messages.workspace.placeTransformContinueClean)
            : messages.workspace.pickChipPlace
        }
        canSubmit={pickingDataset ? datasetCanSubmit : catalogCanSubmit}
        busy={busy}
        onCancel={() => {
          if (pickingDataset) {
            exitDatasetPick();
            return;
          }
          onClose();
        }}
        onSubmit={() => {
          if (pickingDataset) {
            if (!datasetCanSubmit) return;
            onPlaceDataset({
              name: defaultName,
              inputDatasetId: script ? (inputDatasetIds[0] ?? "") : inputDatasetId,
              inputDatasetIds: script ? inputDatasetIds : undefined,
            });
            return;
          }
          if (!catalogCanSubmit) return;
          onPlaceCatalog(catalogSelectedIds);
        }}
      />
    </div>
  );

  return (
    <>
      {main}

      <AppDialog
        open={namingEmpty}
        title={messages.workspace.nameChipTitle}
        zIndex={110}
        className={EMPTY_NAME_DIALOG_CLASS}
        minWidth={384}
        minHeight={240}
        onClose={() => setNamingEmpty(false)}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setNamingEmpty(false)}>
              {messages.common.cancel}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={busy || !emptyName.trim() || !emptyInputReady}
              onClick={() => {
                const trimmed = emptyName.trim();
                if (!trimmed || !emptyInputReady) return;
                setNamingEmpty(false);
                onPlaceEmpty(script
                  ? { name: trimmed, inputChipIds }
                  : { name: trimmed, inputChipId });
              }}
            >
              {messages.workspace.nameChipConfirm}
            </Button>
          </>
        }
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto p-3">
          <p className="shrink-0 text-xs leading-5 text-text-secondary">{messages.workspace.nameChipHint}</p>
          <label className="flex min-w-0 shrink-0 flex-col gap-1.5">
            <span className="text-xs font-semibold text-text">{messages.workspace.chipName}</span>
            <input
              className="field-control text-sm"
              value={emptyName}
              autoFocus
              disabled={busy}
              onChange={(event) => setEmptyName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                const trimmed = emptyName.trim();
                if (!trimmed || !emptyInputReady || busy) return;
                setNamingEmpty(false);
                onPlaceEmpty(script
                  ? { name: trimmed, inputChipIds }
                  : { name: trimmed, inputChipId });
              }}
            />
          </label>
          <p className="shrink-0 text-xs leading-5 text-text-tertiary">
            {script ? messages.workspace.scriptInputChipsHint : messages.workspace.inputChipHint}
          </p>
          <CanvasProducerSelect
            chips={canvasChips}
            value={script ? undefined : inputChipId}
            values={script ? inputChipIds : undefined}
            max={script ? MAX_SCRIPT_INPUTS : undefined}
            messages={messages}
            label={messages.workspace.inputChip}
            disabled={busy}
            onChange={setInputChipId}
            onValuesChange={script ? setInputChipIds : undefined}
          />
        </div>
      </AppDialog>
    </>
  );
}

function LoadCatalogPanel({ kind = "load", icon, iconClassName, title, simpleHint, emptyChipLabel, catalogHint, registerLabel, submitLabel, chips, canvasChips, canvasEdges, canvasChipIds, defaultName, occupiedNames, messages, busy, hideEmpty, hideRegister, onClose, onPlace, onPlaceEmpty, onRegister, dragHandleRef }: {
  kind?: "load" | "validation" | "sql" | "serve" | "script"; icon?: ReactNode; iconClassName?: string; title?: string; simpleHint?: string;
  emptyChipLabel?: string; catalogHint?: string; registerLabel?: string; submitLabel?: string;
  chips: Chip[]; canvasChips: Chip[]; canvasEdges?: ChipEdge[]; canvasChipIds: Set<string>; defaultName: string; occupiedNames: string[]; messages: Messages; busy?: boolean;
  hideEmpty?: boolean;
  hideRegister?: boolean;
  onClose: () => void; onPlace: (ids: string[]) => void; onPlaceEmpty?: (draft: EmptyConsumerDraft) => void; onRegister: () => void;
  dragHandleRef: RefObject<HTMLDivElement | null>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [namingEmpty, setNamingEmpty] = useState(false);
  const [emptyName, setEmptyName] = useState(defaultName);
  const [inputChipId, setInputChipId] = useState("");
  const [sourceChipId, setSourceChipId] = useState("");
  const [targetChipId, setTargetChipId] = useState("");
  const [slug, setSlug] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [freshness, setFreshness] = useState<"slot" | "live">("slot");

  useEffect(() => {
    setNamingEmpty(false);
    setEmptyName(defaultName);
    setInputChipId("");
    setSourceChipId("");
    setTargetChipId("");
    setSlug(slugFromName(defaultName));
    setApiKey(kind === "serve" ? newServeApiKey() : "");
    setFreshness("slot");
  }, [defaultName, kind]);
  const nameTaken = occupiedNames.some((name) => name.trim().toLocaleLowerCase() === emptyName.trim().toLocaleLowerCase());
  const emptyReady = kind === "validation"
    ? Boolean(sourceChipId && targetChipId)
    : kind === "serve"
      ? Boolean(inputChipId && slug.trim())
      : Boolean(inputChipId);
  const confirmEmpty = () => {
    const trimmed = emptyName.trim();
    if (!trimmed || busy || nameTaken || !emptyReady) return;
    setNamingEmpty(false);
    onPlaceEmpty?.(kind === "validation"
      ? { name: trimmed, sourceChipId, targetChipId }
      : kind === "serve"
        ? { name: trimmed, inputChipId, slug: slug.trim(), apiKey, freshness }
        : { name: trimmed, inputChipId });
  };

  return (
    <>
      <div className="chip-place-main">
      <PlacePanelHeader
        icon={icon ?? <FileOutput className="size-4" aria-hidden="true" />}
        iconClassName={iconClassName ?? "bg-warning-subtle text-warning"}
        title={title ?? messages.workspace.placeLoadTitle}
        hint={simpleHint ?? messages.workspace.placeLoadSimpleHint}
        dragHandleRef={dragHandleRef}
      />

      <div className={cn("grid shrink-0 gap-2 px-4 pt-4", hideEmpty || hideRegister ? "grid-cols-1" : "grid-cols-2")}>
        {hideEmpty ? null : (
          <Button
            type="button"
            variant="secondary"
            className="h-10 gap-1.5 text-[12px]"
            disabled={busy}
            onClick={() => {
              setEmptyName(defaultName);
              setInputChipId("");
              setSourceChipId("");
              setTargetChipId("");
              setSlug(slugFromName(defaultName));
              setApiKey(kind === "serve" ? newServeApiKey() : "");
              setFreshness("slot");
              setNamingEmpty(true);
            }}
          >
            <Layers3 className="size-3.5" aria-hidden="true" />
            {emptyChipLabel ?? messages.workspace.placeLoadEmptyChip}
          </Button>
        )}
        {hideRegister ? null : (
        <Button
          type="button"
          variant="secondary"
          className="h-10 gap-1.5 text-[12px]"
          disabled={busy}
          onClick={onRegister}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          {registerLabel ?? messages.workspace.registerLoadFirst}
        </Button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-2 pt-4">
        <p className="shrink-0 text-[11px] text-text-tertiary">
          {catalogHint ?? messages.workspace.placeLoadCatalogHint}
        </p>
        <CatalogChipPanel
          kind={kind}
          chips={chips}
          canvasChipIds={canvasChipIds}
          messages={messages}
          selectedIds={selected}
          onSelectedIdsChange={setSelected}
        />
      </div>

      <PlaceDialogFooter
        cancelLabel={messages.common.cancel}
        submitLabel={submitLabel ?? messages.workspace.placeSelected}
        canSubmit={selected.length > 0}
        busy={busy}
        onCancel={onClose}
        onSubmit={() => onPlace(selected)}
      />
      </div>
      <AppDialog
        open={namingEmpty}
        title={messages.workspace.nameChipTitle}
        zIndex={110}
        className={kind === "validation" || kind === "serve" ? VALIDATION_NAME_DIALOG_CLASS : EMPTY_NAME_DIALOG_CLASS}
        minWidth={kind === "validation" || kind === "serve" ? 560 : 384}
        minHeight={kind === "validation" || kind === "serve" ? 520 : 240}
        onClose={() => setNamingEmpty(false)}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setNamingEmpty(false)}>
              {messages.common.cancel}
            </Button>
            <Button type="button" variant="primary" disabled={busy || !emptyName.trim() || nameTaken || !emptyReady} onClick={confirmEmpty}>
              {messages.workspace.nameChipConfirm}
            </Button>
          </>
        }
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto p-3">
          <p className="shrink-0 text-xs leading-5 text-text-secondary">{messages.workspace.nameChipHint}</p>
          <label className="flex min-w-0 shrink-0 flex-col gap-1.5">
            <span className="text-xs font-semibold text-text">{messages.workspace.chipName}</span>
            <input
              className="field-control text-sm"
              value={emptyName}
              autoFocus
              disabled={busy}
              onChange={(event) => {
                const next = event.target.value;
                setEmptyName(next);
                if (kind === "serve" && (!slug || slug === slugFromName(emptyName))) {
                  setSlug(slugFromName(next));
                }
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                confirmEmpty();
              }}
            />
            {nameTaken ? <span className="text-xs text-danger">{messages.workspace.duplicateChipName}</span> : null}
          </label>
          {kind === "validation" ? (
            <>
              <p className="shrink-0 text-xs leading-5 text-text-tertiary">{messages.workspace.validationConfigureHint}</p>
              <div className="grid min-w-0 grid-cols-2 gap-3">
                <CanvasProducerSelect
                  chips={canvasChips}
                  value={sourceChipId}
                  excludeIds={targetChipId ? [targetChipId] : undefined}
                  messages={messages}
                  label={messages.workspace.validationSourceChip}
                  disabled={busy}
                  onChange={setSourceChipId}
                />
                <CanvasProducerSelect
                  chips={canvasChips}
                  value={targetChipId}
                  excludeIds={sourceChipId ? [sourceChipId] : undefined}
                  messages={messages}
                  label={messages.workspace.validationTargetChip}
                  kinds={["extract", "transform", "script", "load"]}
                  disabled={busy}
                  onChange={(id) => {
                    setTargetChipId(id);
                    if (sourceChipId || !id) return;
                    const chip = canvasChips.find((item) => item.id === id);
                    if (chip?.kind !== "load") return;
                    const input = incomingDataChipId(canvasEdges ?? [], id);
                    if (input) setSourceChipId(input);
                  }}
                />
              </div>
            </>
          ) : (
            <>
              <p className="shrink-0 text-xs leading-5 text-text-tertiary">{messages.workspace.inputChipHint}</p>
              <CanvasProducerSelect
                chips={canvasChips}
                value={inputChipId}
                messages={messages}
                label={messages.workspace.inputChip}
                disabled={busy}
                onChange={setInputChipId}
              />
              {kind === "serve" ? (
                <>
                  <label className="flex min-w-0 shrink-0 flex-col gap-1.5">
                    <span className="flex min-h-4 min-w-0 items-baseline justify-between gap-2">
                      <span className="text-xs font-semibold text-text">{messages.workspace.serveSlug}</span>
                      <span className="min-w-0 truncate text-right text-[11px] text-text-tertiary">{messages.workspace.serveSlugExample}</span>
                    </span>
                    <input
                      className="field-control text-sm"
                      value={slug}
                      placeholder={messages.workspace.serveSlugPlaceholder}
                      disabled={busy}
                      onChange={(event) => setSlug(event.target.value)}
                    />
                    {slug.trim() ? (
                      <span className="font-mono text-[11px] text-text-tertiary">{messages.workspace.servePathLabel(slug.trim())}</span>
                    ) : (
                      <span className="text-[11px] leading-4 text-text-tertiary">{messages.workspace.serveSlugHint}</span>
                    )}
                  </label>
                  <label className="flex min-w-0 shrink-0 flex-col gap-1.5">
                    <span className="text-xs font-semibold text-text">{messages.workspace.serveApiKey}</span>
                    <input className="field-control font-mono text-[12px]" value={apiKey} readOnly />
                    <span className="text-[11px] leading-5 text-text-tertiary">{messages.workspace.serveApiKeyHint}</span>
                  </label>
                  <label className="flex min-w-0 shrink-0 flex-col gap-1.5">
                    <span className="text-xs font-semibold text-text">{messages.workspace.serveFreshness}</span>
                    <Select
                      value={freshness}
                      disabled={busy}
                      options={[
                        { value: "slot", label: messages.workspace.serveFreshnessSlot },
                        { value: "live", label: messages.workspace.serveFreshnessLive },
                      ]}
                      onChange={(value) => setFreshness(value === "live" ? "live" : "slot")}
                    />
                  </label>
                </>
              ) : null}
            </>
          )}
        </div>
      </AppDialog>
    </>
  );
}

export function ChipPlaceDialog({
  open,
  kind,
  workspaceId,
  workspaceReturnState,
  catalogChips,
  datasets,
  canvasChips,
  canvasEdges,
  canvasChipIds,
  defaultTransformName,
  defaultLoadName,
  defaultValidationName,
  defaultSqlName,
  defaultScriptName,
  defaultServeName,
  occupiedNames,
  messages,
  busy,
  onClose,
  onPlaceCatalog,
  onPlaceNewTransform,
  onPlaceNewLoad,
  onPlaceNewValidation,
  onPlaceNewServe,
  onPlaceNewScript,
  onRegisterSql,
}: {
  open: boolean;
  kind: ChipPlaceKind;
  workspaceId?: string;
  workspaceReturnState?: unknown;
  catalogChips: Chip[];
  datasets: Dataset[];
  canvasChips: Chip[];
  canvasEdges?: ChipEdge[];
  canvasChipIds: Set<string>;
  defaultTransformName: string;
  defaultLoadName: string;
  defaultValidationName: string;
  defaultSqlName: string;
  defaultScriptName: string;
  defaultServeName: string;
  occupiedNames: string[];
  messages: Messages;
  busy?: boolean;
  onClose: () => void;
  onPlaceCatalog: (chipIds: string[]) => void;
  onPlaceNewTransform: (draft: TransformPlaceDraft) => void;
  onPlaceNewLoad: (draft: EmptyConsumerDraft) => void;
  onPlaceNewValidation: (draft: EmptyConsumerDraft) => void;
  onPlaceNewServe: (draft: EmptyConsumerDraft) => void;
  onPlaceNewScript: (draft: TransformPlaceDraft) => void;
  onRegisterSql: () => void;
}) {
  const navigate = useNavigate();
  const dragHandleRef = useRef<HTMLDivElement>(null);
  const dialogTitle = kind === "extract"
    ? messages.workspace.placeExtractTitle
    : kind === "transform" ? messages.workspace.placeTransformTitle
      : kind === "load" ? messages.workspace.placeLoadTitle
        : kind === "sql" ? messages.workspace.placeSqlTitle
          : kind === "script" ? messages.workspace.placeScriptTitle
            : kind === "serve" ? messages.workspace.placeServeTitle : messages.workspace.placeValidationTitle;

  function goDbRegister() {
    onClose();
    navigate("/db", { state: workspaceReturnState ?? { returnWorkspaceId: workspaceId } });
  }

  function goApiRegister() {
    onClose();
    navigate("/extract/api", { state: workspaceReturnState ?? { returnWorkspaceId: workspaceId } });
  }

  return (
    <AppDialog
      open={open}
      title={dialogTitle}
      hideHeader
      dragHandleRef={dragHandleRef}
      className={cn(
        "chip-place-dialog flex max-h-[88vh] max-w-[96vw]",
        "h-[min(40rem,88vh)] w-[26rem]",
      )}
      minWidth={416}
      minHeight={480}
      onClose={onClose}
    >
      {kind === "extract" ? (
        <ExtractNewPanel
          messages={messages}
          busy={busy}
          onClose={onClose}
          onPlaceCatalog={onPlaceCatalog}
          onRegisterDb={goDbRegister}
          onRegisterApi={goApiRegister}
          catalogChips={catalogChips}
          canvasChipIds={canvasChipIds}
          dragHandleRef={dragHandleRef}
        />
      ) : kind === "transform" ? (
        <TransformNewPanel
          datasets={datasets}
          defaultName={defaultTransformName}
          messages={messages}
          busy={busy}
          onClose={onClose}
          onPlaceEmpty={(draft) => onPlaceNewTransform({
            name: draft.name,
            inputDatasetId: "",
            inputChipId: draft.inputChipId,
          })}
          onPlaceDataset={onPlaceNewTransform}
          onPlaceCatalog={onPlaceCatalog}
          catalogChips={catalogChips}
          canvasChips={canvasChips}
          canvasChipIds={canvasChipIds}
          dragHandleRef={dragHandleRef}
        />
      ) : kind === "load" ? (
        <LoadCatalogPanel
          chips={catalogChips}
          canvasChips={canvasChips}
          canvasEdges={canvasEdges}
          canvasChipIds={canvasChipIds}
          defaultName={defaultLoadName}
          occupiedNames={occupiedNames}
          messages={messages}
          busy={busy}
          onClose={onClose}
          onPlace={onPlaceCatalog}
          onPlaceEmpty={onPlaceNewLoad}
          onRegister={() => {
            onClose();
            navigate("/load", { state: workspaceReturnState ?? { returnWorkspaceId: workspaceId } });
          }}
          dragHandleRef={dragHandleRef}
        />
      ) : kind === "sql" ? (
        <LoadCatalogPanel
          kind="sql"
          hideEmpty
          icon={<Terminal className="size-4" aria-hidden="true" />}
          iconClassName="bg-sky-500/10 text-sky-600 dark:text-sky-400"
          title={messages.workspace.placeSqlTitle}
          simpleHint={messages.workspace.placeSqlSimpleHint}
          catalogHint={messages.workspace.placeSqlCatalogHint}
          registerLabel={messages.workspace.registerNewChip}
          submitLabel={messages.workspace.pickChipPlace}
          chips={catalogChips}
          canvasChips={canvasChips}
          canvasEdges={canvasEdges}
          canvasChipIds={canvasChipIds}
          defaultName={defaultSqlName}
          occupiedNames={occupiedNames}
          messages={messages}
          busy={busy}
          onClose={onClose}
          onPlace={onPlaceCatalog}
          onRegister={onRegisterSql}
          dragHandleRef={dragHandleRef}
        />
      ) : kind === "script" ? (
        <TransformNewPanel
          kind="script"
          datasets={datasets}
          defaultName={defaultScriptName}
          messages={messages}
          busy={busy}
          onClose={onClose}
          onPlaceEmpty={(draft) => onPlaceNewScript({
            name: draft.name,
            inputDatasetId: "",
            inputChipId: draft.inputChipId,
            inputChipIds: draft.inputChipIds,
          })}
          onPlaceDataset={onPlaceNewScript}
          onPlaceCatalog={onPlaceCatalog}
          catalogChips={catalogChips}
          canvasChips={canvasChips}
          canvasChipIds={canvasChipIds}
          dragHandleRef={dragHandleRef}
        />
      ) : kind === "serve" ? (
        <LoadCatalogPanel
          kind="serve"
          hideRegister
          icon={<Globe className="size-4" aria-hidden="true" />}
          iconClassName="bg-teal-500/10 text-teal-600 dark:text-teal-400"
          title={messages.workspace.placeServeTitle}
          simpleHint={messages.workspace.placeServeSimpleHint}
          emptyChipLabel={messages.workspace.placeServeEmptyChip}
          catalogHint={messages.workspace.placeServeCatalogHint}
          chips={catalogChips}
          canvasChips={canvasChips}
          canvasEdges={canvasEdges}
          canvasChipIds={canvasChipIds}
          defaultName={defaultServeName}
          occupiedNames={occupiedNames}
          messages={messages}
          busy={busy}
          onClose={onClose}
          onPlace={onPlaceCatalog}
          onPlaceEmpty={onPlaceNewServe}
          onRegister={() => {}}
          dragHandleRef={dragHandleRef}
        />
      ) : (
        <LoadCatalogPanel
          kind="validation"
          icon={<ShieldCheck className="size-4" aria-hidden="true" />}
          iconClassName="bg-violet-500/10 text-violet-600 dark:text-violet-400"
          title={messages.workspace.placeValidationTitle}
          simpleHint={messages.workspace.validationPlaceHint}
          emptyChipLabel={messages.workspace.placeValidationEmptyChip}
          catalogHint={messages.workspace.placeValidationCatalogHint}
          registerLabel={messages.workspace.registerValidationFirst}
          chips={catalogChips}
          canvasChips={canvasChips}
          canvasEdges={canvasEdges}
          canvasChipIds={canvasChipIds}
          defaultName={defaultValidationName}
          occupiedNames={occupiedNames}
          messages={messages}
          busy={busy}
          onClose={onClose}
          onPlace={onPlaceCatalog}
          onPlaceEmpty={onPlaceNewValidation}
          onRegister={() => { onClose(); navigate("/validation"); }}
          dragHandleRef={dragHandleRef}
        />
      )}
    </AppDialog>
  );
}
