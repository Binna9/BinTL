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
import { useViewTransitionState } from "@/hooks/useViewTransitionState";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { connectionApi } from "@/services/connectionApi";
import type { Messages } from "@/i18n/ko";
import { cn } from "@/lib/cn";
import { fmtWhen } from "@/lib/format";
import type { CatalogLayout, CatalogSelection, DataConnection } from "@/types/connection";
import type { Chip } from "@/types/chip";
import type { Dataset } from "@/types/dataset";

export type ChipPlaceKind = "extract" | "transform";

export type ExtractSourceMode = "database" | "api";

export type ExtractPlaceDraft = {
  name: string;
  outputName: string;
  sourceMode: ExtractSourceMode;
  connectionId: string;
  selection: CatalogSelection | null;
  sql: string;
  delimiter: string;
  header: boolean;
};

export type TransformPlaceDraft = {
  name: string;
  inputDatasetId: string;
};

type PlaceMode = "new" | "catalog";

type TableHit = {
  key: string;
  title: string;
  subtitle: string;
  selection: CatalogSelection;
};

function qualifiedTable(layout: CatalogLayout, _database: string, schema: string | null, table: string) {
  if (layout === "database.schema.table") {
    return schema ? `${schema}.${table}` : table;
  }
  return table;
}

async function loadTableHits(connectionId: string): Promise<TableHit[]> {
  const response = await connectionApi.getDatabases(connectionId);
  const layout = response.layout;
  const hits: TableHit[] = [];

  for (const database of response.databases) {
    if (layout === "database.schema.table") {
      const schemas = await connectionApi.getSchemas(connectionId, database.name);
      for (const schema of schemas.schemas) {
        if (schema.kind !== "schema") continue;
        const relations = await connectionApi.getRelations(
          connectionId,
          database.name,
          schema.name,
        );
        for (const item of relations.tables) {
          if (item.kind !== "table" && item.kind !== "view") continue;
          hits.push({
            key: `${database.name}:${schema.name}:${item.name}`,
            title: item.name,
            subtitle: `${database.name} · ${schema.name}`,
            selection: {
              database: database.name,
              schema: schema.name,
              table: item.name,
              qualified: qualifiedTable(layout, database.name, schema.name, item.name),
            },
          });
        }
      }
      continue;
    }

    const relations = await connectionApi.getRelations(connectionId, database.name);
    for (const item of relations.tables) {
      if (item.kind !== "table" && item.kind !== "view") continue;
      hits.push({
        key: `${database.name}:${item.name}`,
        title: item.name,
        subtitle: database.name,
        selection: {
          database: database.name,
          schema: null,
          table: item.name,
          qualified: qualifiedTable(layout, database.name, null, item.name),
        },
      });
    }
  }

  return hits.sort((left, right) => left.title.localeCompare(right.title, "ko"));
}

function sqlForTable(selection: CatalogSelection) {
  return `SELECT *\nFROM ${selection.qualified}`;
}

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

function ExtractSourcePicker({
  value,
  onChange,
  messages,
}: {
  value: ExtractSourceMode;
  onChange: (mode: ExtractSourceMode) => void;
  messages: Messages;
}) {
  const options: { id: ExtractSourceMode; label: string; icon: typeof Database }[] = [
    { id: "database", label: messages.workspace.placeExtractSourceDb, icon: Database },
    { id: "api", label: messages.workspace.placeExtractSourceApi, icon: Cloud },
  ];
  return (
    <div className="grid grid-cols-2 gap-2">
      {options.map((option) => {
        const Icon = option.icon;
        const active = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs font-semibold transition-colors",
              active
                ? "border-accent bg-accent-subtle text-accent"
                : "border-border bg-surface text-text-secondary hover:bg-subtle",
            )}
            onClick={() => onChange(option.id)}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {option.label}
          </button>
        );
      })}
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
}: {
  kind: ChipPlaceKind;
  chips: Chip[];
  canvasChipIds: Set<string>;
  messages: Messages;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
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
    <div className="flex h-full min-h-0 flex-col gap-3">
      <p className="shrink-0 text-xs text-text-secondary">{messages.workspace.pickChipHint}</p>
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
      <ul className="scroll-pane m-0 min-h-0 flex-1 list-none divide-y divide-border/50 overflow-y-auto rounded-lg border border-border/60 p-0">
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

function DbConnectionLayer({
  connections,
  connectionId,
  selection,
  tableQuery,
  tableHits,
  loadingTables,
  tableError,
  messages,
  onPickConnection,
  onPickTable,
  onTableQueryChange,
}: {
  connections: DataConnection[];
  connectionId: string;
  selection: CatalogSelection | null;
  tableQuery: string;
  tableHits: TableHit[];
  loadingTables: boolean;
  tableError: string;
  messages: Messages;
  onPickConnection: (id: string) => void;
  onPickTable: (hit: TableHit) => void;
  onTableQueryChange: (value: string) => void;
}) {
  const filteredHits = useMemo(() => {
    const needle = tableQuery.trim().toLowerCase();
    if (!needle) return tableHits;
    return tableHits.filter(
      (hit) =>
        hit.title.toLowerCase().includes(needle)
        || hit.subtitle.toLowerCase().includes(needle)
        || hit.selection.qualified.toLowerCase().includes(needle),
    );
  }, [tableHits, tableQuery]);

  return (
    <aside className="chip-place-side" aria-label={messages.workspace.placeExtractConnectionTableTitle}>
      <h3 className="chip-place-side-title">
        <Database className="size-3.5" aria-hidden="true" />
        {messages.workspace.placeExtractConnectionTableTitle}
      </h3>
      <ul className="chip-place-side-list scroll-pane max-h-36 shrink-0 overflow-y-auto">
        {connections.length === 0 ? (
          <li className="px-1 py-1 text-[12px] text-text-tertiary">{messages.empty.connections}</li>
        ) : (
          connections.map((connection) => (
            <li key={connection.id}>
              <button
                type="button"
                className={cn("chip-place-side-item", connection.id === connectionId && "is-active")}
                onClick={() => onPickConnection(connection.id)}
              >
                <span className="block truncate text-[13px] font-medium text-text">{connection.name}</span>
                <span className="mt-0.5 block truncate text-[10px] text-text-tertiary">{connection.driver}</span>
              </button>
            </li>
          ))
        )}
      </ul>
      {connectionId ? (
        <>
          <div className="chip-place-side-search">
            <Search className="size-3 shrink-0 text-text-tertiary" aria-hidden="true" />
            <input
              type="search"
              value={tableQuery}
              placeholder={messages.workspace.placeExtractTableSearch}
              onChange={(event) => onTableQueryChange(event.target.value)}
            />
          </div>
          <ul className="chip-place-side-list scroll-pane min-h-0 flex-1 overflow-y-auto">
            {loadingTables ? (
              <li className="px-1 py-2 text-[12px] text-text-tertiary">{messages.common.loading}</li>
            ) : tableError ? (
              <li className="px-1 py-2 text-[12px] text-danger">{tableError}</li>
            ) : filteredHits.length === 0 ? (
              <li className="px-1 py-2 text-[12px] text-text-tertiary">{messages.workspace.placeExtractTableEmpty}</li>
            ) : (
              filteredHits.map((hit) => (
                <li key={hit.key}>
                  <button
                    type="button"
                    className={cn(
                      "chip-place-side-item",
                      selection?.qualified === hit.selection.qualified && "is-active",
                    )}
                    onClick={() => onPickTable(hit)}
                  >
                    <span className="block truncate text-[12px] font-medium text-text">{hit.title}</span>
                    <span className="mt-0.5 block truncate text-[10px] text-text-tertiary">{hit.subtitle}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </>
      ) : (
        <p className="px-1 text-[11px] leading-5 text-text-tertiary">{messages.workspace.placeExtractPickConnection}</p>
      )}
    </aside>
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

function SqlEditorPanel({
  sql,
  selection,
  messages,
  onChange,
}: {
  sql: string;
  selection: CatalogSelection | null;
  messages: Messages;
  onChange: (value: string) => void;
}) {
  return (
    <aside className="chip-place-side chip-place-sql" aria-label={messages.workspace.placeExtractSqlTitle}>
      <h3 className="chip-place-side-title">
        <Database className="size-3.5" aria-hidden="true" />
        {messages.workspace.placeExtractSqlTitle}
      </h3>
      {selection ? (
        <p className="mb-2 px-0.5 text-[11px] text-text-tertiary">
          {messages.workspace.placeExtractSelectedTable}:{" "}
          <span className="font-medium text-text">{selection.qualified}</span>
        </p>
      ) : (
        <p className="mb-2 px-0.5 text-[11px] text-text-tertiary">{messages.workspace.placeExtractSqlHint}</p>
      )}
      <textarea
        className="field-control technical min-h-0 flex-1 resize-none font-mono text-xs leading-5"
        value={sql}
        spellCheck={false}
        placeholder={messages.workspace.placeExtractSqlPlaceholder}
        onChange={(event) => onChange(event.target.value)}
      />
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
  connections,
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
  connections: DataConnection[];
  defaultName: string;
  mode: PlaceMode;
  onModeChange: (mode: PlaceMode) => void;
  messages: Messages;
  busy?: boolean;
  onClose: () => void;
  onSubmit: (draft: ExtractPlaceDraft) => void;
  onPlaceCatalog: (chipIds: string[]) => void;
  onPageRegister: () => void;
  catalogChips: Chip[];
  canvasChipIds: Set<string>;
  dragHandleRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const [chipName, setChipName] = useState(defaultName);
  const [outputName, setOutputName] = useState("");
  const [sourceMode, setSourceMode] = useViewTransitionState<ExtractSourceMode>("database");
  const [connectionId, setConnectionId] = useState("");
  const [selection, setSelection] = useState<CatalogSelection | null>(null);
  const [sql, setSql] = useState("");
  const [sqlTouched, setSqlTouched] = useState(false);
  const [tableQuery, setTableQuery] = useState("");
  const [tableHits, setTableHits] = useState<TableHit[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [tableError, setTableError] = useState("");
  const [catalogSelectedIds, setCatalogSelectedIds] = useState<string[]>([]);

  useEffect(() => {
    setChipName(defaultName);
    setOutputName("");
    setSourceMode("database", { instant: true });
    setConnectionId("");
    setSelection(null);
    setSql("");
    setSqlTouched(false);
    setTableQuery("");
    setTableHits([]);
    setTableError("");
    setCatalogSelectedIds([]);
  }, [defaultName]);

  useEffect(() => {
    setCatalogSelectedIds([]);
  }, [mode]);

  useEffect(() => {
    if (sourceMode !== "database" || !connectionId) {
      setTableHits([]);
      return;
    }
    let cancelled = false;
    setLoadingTables(true);
    setTableError("");
    void loadTableHits(connectionId)
      .then((hits) => {
        if (!cancelled) setTableHits(hits);
      })
      .catch(() => {
        if (!cancelled) setTableError(messages.workspace.placeExtractTableLoadError);
      })
      .finally(() => {
        if (!cancelled) setLoadingTables(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, sourceMode, messages.workspace.placeExtractTableLoadError]);

  function pickTable(hit: TableHit) {
    setSelection(hit.selection);
    setOutputName((current) => current.trim() || hit.selection.qualified.replace(/\./g, "_"));
    if (!sqlTouched) setSql(sqlForTable(hit.selection));
  }

  const canSubmit = Boolean(
    chipName.trim()
    && sourceMode === "database"
    && connectionId
    && (sql.trim() || selection),
  );

  const showDbPanels = mode === "new" && sourceMode === "database";
  const catalogCanSubmit = catalogSelectedIds.length > 0;

  function submitExtract() {
    if (!canSubmit) return;
    onSubmit({
      name: chipName.trim(),
      outputName: outputName.trim() || selection?.qualified.replace(/\./g, "_") || chipName.trim(),
      sourceMode,
      connectionId,
      selection,
      sql: sql.trim(),
      delimiter: ",",
      header: true,
    });
  }

  return (
    <DialogContentTransition
      contentKey={mode === "new" ? `new:${sourceMode}` : "catalog"}
      className="chip-place-body"
    >
      {showDbPanels ? (
        <DbConnectionLayer
          connections={connections}
          connectionId={connectionId}
          selection={selection}
          tableQuery={tableQuery}
          tableHits={tableHits}
          loadingTables={loadingTables}
          tableError={tableError}
          messages={messages}
          onPickConnection={(id) => {
            setConnectionId(id);
            setSelection(null);
            setSql("");
            setSqlTouched(false);
          }}
          onPickTable={pickTable}
          onTableQueryChange={setTableQuery}
        />
      ) : null}

      <div className="chip-place-main">
        <PlacePanelHeader
          icon={<DatabaseZap className="size-4" aria-hidden="true" />}
          iconClassName="bg-accent-subtle text-accent"
          title={messages.workspace.placeExtractTitle}
          hint={messages.workspace.placeNewChipHint}
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
              kind="extract"
              chips={catalogChips}
              canvasChipIds={canvasChipIds}
              messages={messages}
              selectedIds={catalogSelectedIds}
              onSelectedIdsChange={setCatalogSelectedIds}
            />
          ) : sourceMode === "api" ? (
            <div className="flex min-h-[14rem] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-subtle/30 px-6 py-10 text-center">
              <Cloud className="size-8 text-text-tertiary" aria-hidden="true" />
              <p className="mt-3 text-sm font-medium text-text">{messages.workspace.placeExtractApiTitle}</p>
              <p className="mt-2 max-w-xs text-xs leading-5 text-text-tertiary">{messages.workspace.placeExtractApiHint}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <FormField label={messages.workspace.chipName}>
                <input className="field-control text-sm" value={chipName} onChange={(e) => setChipName(e.target.value)} />
              </FormField>
              <FormField label={messages.workspace.placeExtractDatasetName}>
                <input
                  className="field-control technical text-sm"
                  value={outputName}
                  placeholder={messages.workspace.placeExtractDatasetPlaceholder}
                  onChange={(e) => setOutputName(e.target.value)}
                />
              </FormField>
              <FormField label={messages.workspace.placeExtractSourceKind}>
                <ExtractSourcePicker
                  value={sourceMode}
                  onChange={(next) => {
                    setSourceMode(next);
                    setConnectionId("");
                    setSelection(null);
                    setSql("");
                    setSqlTouched(false);
                  }}
                  messages={messages}
                />
              </FormField>
            </div>
          )}
          </div>
        </div>

        <PlaceDialogFooter
          cancelLabel={messages.common.cancel}
          submitLabel={messages.workspace.placeExtractRegister}
          canSubmit={mode === "catalog" ? catalogCanSubmit : canSubmit}
          busy={busy}
          onCancel={onClose}
          onSubmit={() => {
            if (mode === "catalog") {
              if (!catalogCanSubmit) return;
              onPlaceCatalog(catalogSelectedIds);
              return;
            }
            submitExtract();
          }}
        />
      </div>

      {showDbPanels ? (
        <SqlEditorPanel
          sql={sql}
          selection={selection}
          messages={messages}
          onChange={(value) => {
            setSql(value);
            setSqlTouched(true);
          }}
        />
      ) : null}
    </DialogContentTransition>
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
  const [wireLater, setWireLater] = useState(false);
  const [catalogSelectedIds, setCatalogSelectedIds] = useState<string[]>([]);

  const inputDatasets = useMemo(
    () => datasets.filter((dataset) => dataset.kind !== "transform"),
    [datasets],
  );

  useEffect(() => {
    setName(defaultName);
    setInputDatasetId("");
    setDatasetQuery("");
    setWireLater(false);
    setCatalogSelectedIds([]);
  }, [defaultName]);

  useEffect(() => {
    setCatalogSelectedIds([]);
  }, [mode]);

  const canSubmit = Boolean(name.trim() && (wireLater || inputDatasetId));
  const catalogCanSubmit = catalogSelectedIds.length > 0;
  const showDatasetPanel = mode === "new" && !wireLater;

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
              <label className="flex items-start gap-2 text-xs text-text-secondary">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={wireLater}
                  onChange={(e) => {
                    setWireLater(e.target.checked);
                    if (e.target.checked) setInputDatasetId("");
                  }}
                />
                <span>{messages.workspace.placeTransformWireLater}</span>
              </label>
              {!wireLater ? (
                <p className="text-[11px] text-text-tertiary">{messages.workspace.placeTransformPickDataset}</p>
              ) : (
                <p className="text-[11px] text-text-tertiary">{messages.workspace.placeNewTransformSteps}</p>
              )}
            </div>
          )}
          </div>
        </div>

        <PlaceDialogFooter
          cancelLabel={messages.common.cancel}
          submitLabel={messages.workspace.placeExtractRegister}
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
  connections,
  datasets,
  canvasChipIds,
  defaultExtractIndex,
  defaultTransformIndex,
  messages,
  busy,
  onClose,
  onPlaceCatalog,
  onPlaceNewExtract,
  onPlaceNewTransform,
}: {
  open: boolean;
  kind: ChipPlaceKind;
  catalogChips: Chip[];
  connections: DataConnection[];
  datasets: Dataset[];
  canvasChipIds: Set<string>;
  defaultExtractIndex: number;
  defaultTransformIndex: number;
  messages: Messages;
  busy?: boolean;
  onClose: () => void;
  onPlaceCatalog: (chipIds: string[]) => void;
  onPlaceNewExtract: (draft: ExtractPlaceDraft) => void;
  onPlaceNewTransform: (draft: TransformPlaceDraft) => void;
}) {
  const navigate = useNavigate();
  const dragHandleRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<PlaceMode>("new");
  const dialogTitle = kind === "extract"
    ? messages.workspace.placeExtractTitle
    : messages.workspace.placeTransformTitle;
  const pagePath = kind === "extract" ? "/query" : "/transform/clean";

  useEffect(() => {
    if (!open) return;
    setMode("new");
  }, [open, kind]);

  function goPageRegister() {
    onClose();
    navigate(pagePath);
  }

  return (
    <AppDialog
      open={open}
      title={dialogTitle}
      hideHeader
      dragHandleRef={dragHandleRef}
      className="chip-place-dialog flex h-[min(36rem,88vh)] max-h-[88vh] w-auto max-w-[96vw]"
      minWidth={448}
      minHeight={420}
      onClose={onClose}
    >
      {kind === "extract" ? (
        <ExtractNewPanel
          connections={connections}
          defaultName={messages.workspace.defaultExtractChipName(defaultExtractIndex)}
          mode={mode}
          onModeChange={setMode}
          messages={messages}
          busy={busy}
          onClose={onClose}
          onSubmit={onPlaceNewExtract}
          onPlaceCatalog={onPlaceCatalog}
          onPageRegister={goPageRegister}
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
          onPageRegister={goPageRegister}
          catalogChips={catalogChips}
          canvasChipIds={canvasChipIds}
          dragHandleRef={dragHandleRef}
        />
      )}
    </AppDialog>
  );
}
