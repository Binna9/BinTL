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
  Layers3,
  Plus,
  Search,
  Upload,
  Workflow,
} from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { Button } from "@/components/ui/button";
import type { Messages } from "@/i18n/ko";
import { cn } from "@/lib/cn";
import { fmtBytes } from "@/lib/format";
import { selectableClass } from "@/lib/selectable";
import type { Chip } from "@/types/chip";
import type { Dataset } from "@/types/dataset";

export type ChipPlaceKind = "extract" | "transform" | "load";

export type TransformPlaceDraft = {
  name: string;
  inputDatasetId: string;
};

const DATASET_KIND_ORDER = ["upload", "database", "api"] as const;
type DatasetKind = (typeof DATASET_KIND_ORDER)[number];

const DATASET_KIND_APPEARANCE = {
  upload: {
    icon: Upload,
    header: "border-accent/20 bg-accent-subtle text-accent",
    count: "bg-accent/10 text-accent",
  },
  database: {
    icon: Database,
    header: "border-success/20 bg-success-subtle text-success",
    count: "bg-success/10 text-success",
  },
  api: {
    icon: Braces,
    header: "border-warning/20 bg-warning-subtle text-warning",
    count: "bg-warning/10 text-warning",
  },
} as const;

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
  const RowIcon = kind === "extract" ? DatabaseZap : kind === "transform" ? Workflow : FileOutput;
  const iconClassName = kind === "extract" ? "text-accent" : kind === "transform" ? "text-success" : "text-warning";
  const emptyHint = kind === "extract"
    ? messages.workspace.emptyCatalogExtract
    : kind === "transform" ? messages.workspace.emptyCatalogTransform : messages.workspace.emptyCatalogLoad;

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
          const selected = selectedIds.includes(chip.id);
          return (
            <li key={chip.id}>
              <button
                type="button"
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none",
                  selected ? "bg-accent-subtle/80" : "hover:bg-subtle/70",
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
                {canvasChipIds.has(chip.id) ? (
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
      <Button type="button" variant="primary" disabled={busy || !canSubmit} onClick={onSubmit}>
        {submitLabel}
      </Button>
    </div>
  );
}

function DatasetPickerPanel({
  title,
  datasets,
  selectedId,
  emptyLabel,
  messages,
  onPick,
  className,
}: {
  title: string;
  datasets: Dataset[];
  selectedId: string;
  emptyLabel: string;
  messages: Messages;
  onPick: (dataset: Dataset) => void;
  className?: string;
}) {
  const [expandedKinds, setExpandedKinds] = useState<Set<DatasetKind>>(() => new Set());
  const [kindSearch, setKindSearch] = useState<Record<DatasetKind, string>>({
    upload: "",
    database: "",
    api: "",
  });

  const kindLabel: Record<DatasetKind, string> = {
    upload: messages.transform.kindUpload,
    database: messages.transform.kindDatabase,
    api: messages.transform.kindApi,
  };

  const grouped = useMemo(() => {
    const buckets: Record<DatasetKind, Dataset[]> = {
      upload: [],
      database: [],
      api: [],
    };
    for (const dataset of datasets) {
      if (dataset.kind === "upload" || dataset.kind === "database" || dataset.kind === "api") {
        buckets[dataset.kind].push(dataset);
      }
    }
    return DATASET_KIND_ORDER
      .map((kind) => ({ kind, items: buckets[kind] }))
      .filter((group) => group.items.length > 0);
  }, [datasets]);

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
              const appearance = DATASET_KIND_APPEARANCE[group.kind];
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
                    ? visibleItems.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className={cn(
                            "flex w-full min-w-0 items-start gap-2 border-b border-border px-2.5 py-2 text-left last:border-b-0",
                            selectableClass(item.id === selectedId),
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
                              {item.status === "planned" ? (
                                <span className="ml-1 text-[10px] font-normal text-accent">
                                  ({messages.transform.plannedInput})
                                </span>
                              ) : !item.available ? (
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
                        </button>
                      ))
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
  datasets,
  defaultName,
  messages,
  busy,
  onClose,
  onPlaceEmpty,
  onPlaceDataset,
  onPlaceCatalog,
  catalogChips,
  canvasChipIds,
  dragHandleRef,
}: {
  datasets: Dataset[];
  defaultName: string;
  messages: Messages;
  busy?: boolean;
  onClose: () => void;
  onPlaceEmpty: (name: string) => void;
  onPlaceDataset: (draft: TransformPlaceDraft) => void;
  onPlaceCatalog: (chipIds: string[]) => void;
  catalogChips: Chip[];
  canvasChipIds: Set<string>;
  dragHandleRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const [pickingDataset, setPickingDataset] = useState(false);
  const [namingEmpty, setNamingEmpty] = useState(false);
  const [emptyName, setEmptyName] = useState(defaultName);
  const [inputDatasetId, setInputDatasetId] = useState("");
  const [catalogSelectedIds, setCatalogSelectedIds] = useState<string[]>([]);

  const inputDatasets = useMemo(
    () => datasets.filter((dataset) => dataset.kind !== "transform"),
    [datasets],
  );

  useEffect(() => {
    setPickingDataset(false);
    setNamingEmpty(false);
    setEmptyName(defaultName);
    setInputDatasetId("");
    setCatalogSelectedIds([]);
  }, [defaultName]);

  const catalogCanSubmit = catalogSelectedIds.length > 0;
  const datasetCanSubmit = Boolean(inputDatasetId);

  function exitDatasetPick() {
    setPickingDataset(false);
    setInputDatasetId("");
  }

  const main = (
    <div className="chip-place-main">
      <PlacePanelHeader
        icon={<Workflow className="size-4" aria-hidden="true" />}
        iconClassName="bg-success-subtle text-success"
        title={messages.workspace.placeTransformTitle}
        hint={messages.workspace.placeTransformSimpleHint}
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
            setNamingEmpty(true);
          }}
        >
          <Layers3 className="size-3.5" aria-hidden="true" />
          {messages.workspace.placeTransformEmptyChip}
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
          {messages.workspace.placeTransformFromDataset}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-2 pt-4">
        {pickingDataset ? (
          <>
            <p className="shrink-0 text-[11px] text-text-tertiary">
              {messages.workspace.placeTransformDatasetHint}
            </p>
            <DatasetPickerPanel
              title={messages.workspace.placeTransformInputDataset}
              datasets={inputDatasets}
              selectedId={inputDatasetId}
              emptyLabel={messages.workspace.placeExtractFileEmpty}
              messages={messages}
              onPick={(dataset) => setInputDatasetId(dataset.id)}
            />
          </>
        ) : (
          <>
            <p className="shrink-0 text-[11px] text-text-tertiary">
              {messages.workspace.placeTransformCatalogHint}
            </p>
            <CatalogChipPanel
              kind="transform"
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
            ? messages.workspace.placeTransformContinueClean
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
            onPlaceDataset({ name: defaultName, inputDatasetId });
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
        className="w-[min(24rem,92vw)]"
        onClose={() => setNamingEmpty(false)}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setNamingEmpty(false)}>
              {messages.common.cancel}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={busy || !emptyName.trim()}
              onClick={() => {
                const trimmed = emptyName.trim();
                if (!trimmed) return;
                setNamingEmpty(false);
                onPlaceEmpty(trimmed);
              }}
            >
              {messages.workspace.nameChipConfirm}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 p-4">
          <p className="text-xs leading-5 text-text-secondary">{messages.workspace.nameChipHint}</p>
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs font-medium text-text-secondary">{messages.workspace.chipName}</span>
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
                if (!trimmed || busy) return;
                setNamingEmpty(false);
                onPlaceEmpty(trimmed);
              }}
            />
          </label>
        </div>
      </AppDialog>
    </>
  );
}

function LoadCatalogPanel({ chips, canvasChipIds, messages, busy, onClose, onPlace, onPlaceEmpty, onRegister, dragHandleRef }: {
  chips: Chip[]; canvasChipIds: Set<string>; messages: Messages; busy?: boolean;
  onClose: () => void; onPlace: (ids: string[]) => void; onPlaceEmpty: () => void; onRegister: () => void;
  dragHandleRef: RefObject<HTMLDivElement | null>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <div className="chip-place-main">
      <PlacePanelHeader
        icon={<FileOutput className="size-4" aria-hidden="true" />}
        iconClassName="bg-warning-subtle text-warning"
        title={messages.workspace.placeLoadTitle}
        hint={messages.workspace.placeLoadSimpleHint}
        dragHandleRef={dragHandleRef}
      />

      <div className="grid shrink-0 grid-cols-2 gap-2 px-4 pt-4">
        <Button
          type="button"
          variant="secondary"
          className="h-10 gap-1.5 text-[12px]"
          disabled={busy}
          onClick={onPlaceEmpty}
        >
          <Layers3 className="size-3.5" aria-hidden="true" />
          {messages.workspace.placeLoadEmptyChip}
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="h-10 gap-1.5 text-[12px]"
          disabled={busy}
          onClick={onRegister}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          {messages.workspace.registerLoadFirst}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-2 pt-4">
        <p className="shrink-0 text-[11px] text-text-tertiary">
          {messages.workspace.placeLoadCatalogHint}
        </p>
        <CatalogChipPanel
          kind="load"
          chips={chips}
          canvasChipIds={canvasChipIds}
          messages={messages}
          selectedIds={selected}
          onSelectedIdsChange={setSelected}
        />
      </div>

      <PlaceDialogFooter
        cancelLabel={messages.common.cancel}
        submitLabel={messages.workspace.placeSelected}
        canSubmit={selected.length > 0}
        busy={busy}
        onCancel={onClose}
        onSubmit={() => onPlace(selected)}
      />
    </div>
  );
}

export function ChipPlaceDialog({
  open,
  kind,
  catalogChips,
  datasets,
  canvasChipIds,
  defaultTransformName,
  defaultLoadName,
  messages,
  busy,
  onClose,
  onPlaceCatalog,
  onPlaceNewTransform,
  onPlaceNewLoad,
}: {
  open: boolean;
  kind: ChipPlaceKind;
  catalogChips: Chip[];
  datasets: Dataset[];
  canvasChipIds: Set<string>;
  defaultTransformName: string;
  defaultLoadName: string;
  messages: Messages;
  busy?: boolean;
  onClose: () => void;
  onPlaceCatalog: (chipIds: string[]) => void;
  onPlaceNewTransform: (draft: TransformPlaceDraft) => void;
  onPlaceNewLoad: (name: string) => void;
}) {
  const navigate = useNavigate();
  const dragHandleRef = useRef<HTMLDivElement>(null);
  const dialogTitle = kind === "extract"
    ? messages.workspace.placeExtractTitle
    : kind === "transform" ? messages.workspace.placeTransformTitle : messages.workspace.placeLoadTitle;

  function goDbRegister() {
    onClose();
    navigate("/db");
  }

  function goApiRegister() {
    onClose();
    navigate("/extract/api");
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
          onPlaceEmpty={(name) => onPlaceNewTransform({ name, inputDatasetId: "" })}
          onPlaceDataset={onPlaceNewTransform}
          onPlaceCatalog={onPlaceCatalog}
          catalogChips={catalogChips}
          canvasChipIds={canvasChipIds}
          dragHandleRef={dragHandleRef}
        />
      ) : (
        <LoadCatalogPanel
          chips={catalogChips}
          canvasChipIds={canvasChipIds}
          messages={messages}
          busy={busy}
          onClose={onClose}
          onPlace={onPlaceCatalog}
          onPlaceEmpty={() => onPlaceNewLoad(defaultLoadName)}
          onRegister={() => { onClose(); navigate("/load"); }}
          dragHandleRef={dragHandleRef}
        />
      )}
    </AppDialog>
  );
}
