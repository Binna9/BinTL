import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  Check,
  Cloud,
  Database,
  DatabaseZap,
  FileStack,
  Layers3,
  Plus,
  Search,
  Workflow,
} from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { DialogContentTransition } from "@/components/DialogContentTransition";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import type { Messages } from "@/i18n/ko";
import { showToast } from "@/lib/notifications";
import { cn } from "@/lib/cn";
import { fmtWhen } from "@/lib/format";
import type { Chip } from "@/types/chip";
import type { Dataset } from "@/types/dataset";

export type ChipPlaceKind = "extract" | "transform";

export type TransformPlaceDraft = {
  name: string;
  inputDatasetId: string;
};

type PlaceMode = "new" | "catalog";

function ModeTabs({
  mode,
  onChange,
  messages,
}: {
  mode: PlaceMode;
  onChange: (mode: PlaceMode) => void;
  messages: Messages;
}) {
  const tabs: { id: PlaceMode; label: string; icon: typeof Layers3 }[] = [
    { id: "new", label: messages.workspace.placeModeNew, icon: Layers3 },
    { id: "catalog", label: messages.workspace.placeModeCatalog, icon: DatabaseZap },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const active = mode === tab.id;
        return (
          <Button
            key={tab.id}
            type="button"
            variant="secondary"
            aria-pressed={active}
            className={cn(
              "h-7 gap-1 px-2 text-[11px]",
              active && "border-accent bg-accent-subtle text-accent",
            )}
            onClick={() => onChange(tab.id)}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {tab.label}
          </Button>
        );
      })}
    </div>
  );
}

function PlaceModeBar({
  mode,
  onModeChange,
  messages,
  pageRegister,
}: {
  mode: PlaceMode;
  onModeChange: (mode: PlaceMode) => void;
  messages: Messages;
  pageRegister?: () => void;
}) {
  return (
    <div className="chip-place-mode-bar">
      <ModeTabs mode={mode} onChange={onModeChange} messages={messages} />
      {mode === "catalog" && pageRegister ? (
        <Button type="button" variant="secondary" className="ml-auto h-7 gap-1 px-2 text-[11px]" onClick={pageRegister}>
          <Plus className="size-3.5" aria-hidden="true" />
          {messages.workspace.pageRegisterNew}
        </Button>
      ) : null}
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
  const RowIcon = kind === "extract" ? DatabaseZap : Workflow;
  const iconClassName = kind === "extract" ? "text-accent" : "text-success";
  const emptyHint = kind === "extract"
    ? messages.workspace.emptyCatalogExtract
    : messages.workspace.emptyCatalogTransform;

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
  query,
  selectedId,
  emptyLabel,
  searchPlaceholder,
  messages,
  onQueryChange,
  onPick,
}: {
  title: string;
  datasets: Dataset[];
  query: string;
  selectedId: string;
  emptyLabel: string;
  searchPlaceholder: string;
  messages: Messages;
  onQueryChange: (value: string) => void;
  onPick: (dataset: Dataset) => void;
}) {
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return datasets;
    return datasets.filter(
      (dataset) =>
        dataset.filename.toLowerCase().includes(needle)
        || dataset.kind.toLowerCase().includes(needle),
    );
  }, [datasets, query]);

  return (
    <aside className="chip-place-side" aria-label={title}>
      <h3 className="chip-place-side-title">
        <FileStack className="size-3.5" aria-hidden="true" />
        {title}
      </h3>
      <div className="chip-place-side-search">
        <Search className="size-3 shrink-0 text-text-tertiary" aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder={searchPlaceholder}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </div>
      <div className="scroll-pane min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="px-1 py-4 text-[12px] text-text-tertiary">{emptyLabel}</p>
        ) : (
          <ul className="chip-place-side-list">
            {filtered.map((dataset) => (
              <li key={dataset.id}>
                <button
                  type="button"
                  className={cn("chip-place-side-item text-left", dataset.id === selectedId && "is-active")}
                  onClick={() => onPick(dataset)}
                >
                  <span className="block truncate text-[12px] font-medium text-text">{dataset.filename}</span>
                  <span className="mt-0.5 flex items-center gap-2 text-[10px] text-text-tertiary">
                    <span>{dataset.kind}</span>
                    {dataset.status === "planned" ? (
                      <span className="text-accent">{messages.transform.plannedInput}</span>
                    ) : null}
                    <span className="ml-auto tabular-nums">{fmtWhen(dataset.updated_at)}</span>
                  </span>
                  {dataset.row_count != null ? (
                    <span className="mt-0.5 block text-[10px] text-text-tertiary">
                      {messages.workspace.placeExtractFileRows(dataset.row_count)}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
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
  mode,
  onModeChange,
  messages,
  busy,
  onClose,
  onSubmit,
  onPlaceCatalog,
  onPageRegister,
  catalogChips,
  canvasChipIds,
  dragHandleRef,
}: {
  datasets: Dataset[];
  defaultName: string;
  mode: PlaceMode;
  onModeChange: (mode: PlaceMode) => void;
  messages: Messages;
  busy?: boolean;
  onClose: () => void;
  onSubmit: (draft: TransformPlaceDraft) => void;
  onPlaceCatalog: (chipIds: string[]) => void;
  onPageRegister: () => void;
  catalogChips: Chip[];
  canvasChipIds: Set<string>;
  dragHandleRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const [name, setName] = useState(defaultName);
  const [inputDatasetId, setInputDatasetId] = useState("");
  const [datasetQuery, setDatasetQuery] = useState("");
  const [fromExtract, setFromExtract] = useState(true);
  const [catalogSelectedIds, setCatalogSelectedIds] = useState<string[]>([]);

  const inputDatasets = useMemo(
    () => datasets.filter((dataset) => dataset.kind !== "transform"),
    [datasets],
  );

  useEffect(() => {
    setName(defaultName);
    setInputDatasetId("");
    setDatasetQuery("");
    setFromExtract(true);
    setCatalogSelectedIds([]);
  }, [defaultName]);

  useEffect(() => {
    setCatalogSelectedIds([]);
  }, [mode]);

  const canSubmit = Boolean(name.trim() && (fromExtract || inputDatasetId));
  const catalogCanSubmit = catalogSelectedIds.length > 0;
  const showDatasetPanel = mode === "new" && !fromExtract;

  return (
    <DialogContentTransition contentKey={mode} className="chip-place-body">
      <div className="chip-place-main">
        <PlacePanelHeader
          icon={<Workflow className="size-4" aria-hidden="true" />}
          iconClassName="bg-success-subtle text-success"
          title={messages.workspace.placeTransformTitle}
          hint={messages.workspace.placeTransformHint}
          dragHandleRef={dragHandleRef}
        />

        <div className="chip-place-main-body">
          <PlaceModeBar
            mode={mode}
            onModeChange={onModeChange}
            messages={messages}
            pageRegister={onPageRegister}
          />
          <div className="chip-place-main-content scroll-pane">
            {mode === "catalog" ? (
              <CatalogChipPanel
                kind="transform"
                chips={catalogChips}
                canvasChipIds={canvasChipIds}
                messages={messages}
                selectedIds={catalogSelectedIds}
                onSelectedIdsChange={setCatalogSelectedIds}
              />
            ) : (
              <div className="flex flex-col gap-4">
                <FormField label={messages.workspace.chipName}>
                  <input className="field-control text-sm" value={name} onChange={(e) => setName(e.target.value)} />
                </FormField>
                <div className="grid grid-cols-2 gap-1 rounded-xl border border-border bg-subtle p-1">
                  <button
                    type="button"
                    className={cn(
                      "rounded-lg px-2 py-1.5 text-[12px] font-semibold",
                      fromExtract ? "bg-surface text-text shadow-sm" : "text-text-secondary",
                    )}
                    onClick={() => {
                      setFromExtract(true);
                      setInputDatasetId("");
                    }}
                  >
                    {messages.workspace.placeTransformFromExtract}
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "rounded-lg px-2 py-1.5 text-[12px] font-semibold",
                      !fromExtract ? "bg-surface text-text shadow-sm" : "text-text-secondary",
                    )}
                    onClick={() => setFromExtract(false)}
                  >
                    {messages.workspace.placeTransformFromFile}
                  </button>
                </div>
                {fromExtract ? (
                  <p className="text-[11px] text-text-tertiary">{messages.workspace.placeNewTransformSteps}</p>
                ) : (
                  <p className="text-[11px] text-text-tertiary">{messages.workspace.placeTransformPickDataset}</p>
                )}
              </div>
            )}
          </div>
        </div>

        <PlaceDialogFooter
          cancelLabel={messages.common.cancel}
          submitLabel={mode === "catalog" ? messages.workspace.pickChipPlace : messages.workspace.placeExtractRegister}
          canSubmit={mode === "catalog" ? catalogCanSubmit : canSubmit}
          busy={busy}
          onCancel={onClose}
          onSubmit={() => {
            if (mode === "catalog") {
              if (!catalogCanSubmit) return;
              onPlaceCatalog(catalogSelectedIds);
              return;
            }
            onSubmit({ name: name.trim(), inputDatasetId });
          }}
        />
      </div>

      {showDatasetPanel ? (
        <DatasetPickerPanel
          title={messages.workspace.placeTransformInputDataset}
          datasets={inputDatasets}
          query={datasetQuery}
          selectedId={inputDatasetId}
          emptyLabel={messages.workspace.placeExtractFileEmpty}
          searchPlaceholder={messages.workspace.placeExtractFileSearch}
          messages={messages}
          onQueryChange={setDatasetQuery}
          onPick={(dataset) => setInputDatasetId(dataset.id)}
        />
      ) : null}
    </DialogContentTransition>
  );
}

export function ChipPlaceDialog({
  open,
  kind,
  catalogChips,
  datasets,
  canvasChipIds,
  defaultTransformIndex,
  messages,
  busy,
  onClose,
  onPlaceCatalog,
  onPlaceNewTransform,
}: {
  open: boolean;
  kind: ChipPlaceKind;
  catalogChips: Chip[];
  datasets: Dataset[];
  canvasChipIds: Set<string>;
  defaultTransformIndex: number;
  messages: Messages;
  busy?: boolean;
  onClose: () => void;
  onPlaceCatalog: (chipIds: string[]) => void;
  onPlaceNewTransform: (draft: TransformPlaceDraft) => void;
}) {
  const navigate = useNavigate();
  const dragHandleRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<PlaceMode>("new");
  const dialogTitle = kind === "extract"
    ? messages.workspace.placeExtractTitle
    : messages.workspace.placeTransformTitle;

  useEffect(() => {
    if (!open) return;
    setMode("new");
  }, [open, kind]);

  function goDbRegister() {
    onClose();
    navigate("/db");
  }

  function goApiRegister() {
    onClose();
    showToast(messages.workspace.placeExtractApiTitle, messages.workspace.placeExtractApiHint, "info");
  }

  return (
    <AppDialog
      open={open}
      title={dialogTitle}
      hideHeader
      dragHandleRef={dragHandleRef}
      className={cn(
        "chip-place-dialog flex max-h-[88vh] max-w-[96vw]",
        kind === "extract"
          ? "h-[min(40rem,88vh)] w-[26rem]"
          : "h-[min(36rem,88vh)] w-auto",
      )}
      minWidth={kind === "extract" ? 416 : 448}
      minHeight={kind === "extract" ? 480 : 420}
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
      ) : (
        <TransformNewPanel
          datasets={datasets}
          defaultName={messages.workspace.defaultTransformChipName(defaultTransformIndex)}
          mode={mode}
          onModeChange={setMode}
          messages={messages}
          busy={busy}
          onClose={onClose}
          onSubmit={onPlaceNewTransform}
          onPlaceCatalog={onPlaceCatalog}
          onPageRegister={() => {
            onClose();
            navigate("/transform/clean");
          }}
          catalogChips={catalogChips}
          canvasChipIds={canvasChipIds}
          dragHandleRef={dragHandleRef}
        />
      )}
    </AppDialog>
  );
}
