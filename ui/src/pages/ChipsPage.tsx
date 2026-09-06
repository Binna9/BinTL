import { useCallback, useEffect, useMemo, useState } from "react";
import { ListFilter, Pencil, Puzzle, RefreshCw, Search, Trash2 } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { AppDialog } from "@/components/AppDialog";
import { ChipDetailView } from "@/components/chips/ChipDetailView";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { fmtWhen } from "@/lib/format";
import { showConfirm, toastError, toastSuccess } from "@/lib/notifications";
import { chipApi } from "@/services/chips/chipApi";
import type { Chip, ChipKind } from "@/types/chip";

function kindLabel(kind: ChipKind, messages: ReturnType<typeof useLanguage>["messages"]) {
  if (kind === "extract") return messages.workspace.extract;
  if (kind === "transform") return messages.workspace.transform;
  if (kind === "load") return messages.workspace.load;
  return messages.workspace.validation;
}

export function ChipsPage() {
  const { messages } = useLanguage();
  const [params] = useSearchParams();
  const [chips, setChips] = useState<Chip[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<Chip | null>(null);
  const [nameQuery, setNameQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | ChipKind>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const visibleChips = useMemo(() => {
    const query = nameQuery.trim().toLocaleLowerCase();
    return chips.filter((chip) =>
      (kindFilter === "all" || chip.kind === kindFilter)
      && (statusFilter === "all" || (statusFilter === "active" ? chip.active : !chip.active))
      && (!query || chip.name.toLocaleLowerCase().includes(query)),
    );
  }, [chips, kindFilter, nameQuery, statusFilter]);
  const allSelected = visibleChips.length > 0 && visibleChips.every((chip) => selectedSet.has(chip.id));

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await chipApi.listCatalog();
      setChips(
        [...response.chips].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
      );
    } catch (error) {
      toastError(messages.workspace.loadError, error);
    } finally {
      setLoading(false);
    }
  }, [messages]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const chipId = params.get("chip");
    if (!chipId || loading) return;
    const chip = chips.find((item) => item.id === chipId);
    if (chip) setDetail(chip);
  }, [chips, loading, params]);

  const activeCount = useMemo(() => chips.filter((chip) => chip.active).length, [chips]);

  function toggleOne(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  function toggleAll() {
    setSelected((current) => {
      const visibleIds = new Set(visibleChips.map((chip) => chip.id));
      return allSelected
        ? current.filter((id) => !visibleIds.has(id))
        : [...new Set([...current, ...visibleIds])];
    });
  }

  async function toggleActive(chip: Chip) {
    setBusy(true);
    try {
      const updated = await chipApi.update(chip.id, { active: !chip.active });
      setChips((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      if (detail?.id === updated.id) setDetail(updated);
    } catch (error) {
      toastError(messages.workspace.saveChipError, error);
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelected() {
    if (selected.length === 0) return;
    const confirmed = await showConfirm(
      messages.workspace.deleteChipsTitle,
      messages.workspace.deleteChipsMessage(selected.length),
      { tone: "danger", confirmLabel: messages.common.delete },
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      for (const id of selected) {
        await chipApi.remove(id);
      }
      if (detail && selectedSet.has(detail.id)) setDetail(null);
      setSelected([]);
      setChips((current) => current.filter((item) => !selectedSet.has(item.id)));
      toastSuccess(messages.chips.deleteDone);
    } catch (error) {
      toastError(messages.workspace.deleteChipError, error);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell>
      <PageHeader
        iconName="jobs"
        eyebrow={messages.chips.eyebrow}
        title={messages.chips.title}
        description={messages.chips.description}
        actions={
          <Button type="button" variant="secondary" disabled={loading || busy} onClick={() => void refresh()}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {messages.common.refresh}
          </Button>
        }
      />

      <Panel tall>
        <Toolbar>
          <ToolbarGroup>
            <label className="flex items-center gap-2 text-[13px] font-semibold text-text">
              <input
                className="field-control"
                type="checkbox"
                checked={allSelected}
                disabled={visibleChips.length === 0 || loading || busy}
                onChange={toggleAll}
                aria-label={messages.chips.selectAll}
              />
              <span>{messages.workspace.chipCatalog}</span>
            </label>
            <span className="text-xs text-text-tertiary">
              {messages.chips.showing(visibleChips.length, chips.length)} · {messages.chips.active} {activeCount}
            </span>
          </ToolbarGroup>
          <ToolbarGroup>
            <Button
              type="button"
              variant="danger"
              disabled={selected.length === 0 || busy}
              onClick={() => void deleteSelected()}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {messages.chips.deleteSelected}
            </Button>
          </ToolbarGroup>
        </Toolbar>
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-raised/45 px-3 py-2.5">
          <div className="group flex h-8 w-[min(17rem,100%)] min-w-[11rem] items-center overflow-hidden rounded-lg border border-border bg-surface shadow-sm transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
            <span className="grid h-full w-8 shrink-0 place-items-center border-r border-border bg-subtle text-text-tertiary group-focus-within:text-accent">
              <Search className="size-3.5" aria-hidden="true" />
            </span>
            <input
              type="search"
              className="min-w-0 flex-1 bg-transparent px-2.5 text-[13px] text-text outline-none placeholder:text-text-tertiary"
              value={nameQuery}
              placeholder={messages.chips.searchPlaceholder}
              aria-label={messages.chips.searchByName}
              onChange={(event) => setNameQuery(event.target.value)}
            />
          </div>
          <div className="ml-3 flex items-center gap-1.5 text-xs text-text-secondary">
            <ListFilter className="size-3.5 text-text-tertiary" aria-hidden="true" />
            <span className="sr-only">{messages.chips.kindFilter}</span>
            <Select
              className="h-8 min-w-[7.5rem]"
              value={kindFilter}
              onChange={(value) => setKindFilter(value as "all" | ChipKind)}
              options={[
                { value: "all", label: messages.chips.allKinds },
                { value: "extract", label: kindLabel("extract", messages) },
                { value: "transform", label: kindLabel("transform", messages) },
                { value: "load", label: kindLabel("load", messages) },
                { value: "validation", label: kindLabel("validation", messages) },
              ]}
            />
          </div>
          <div className="flex items-center text-xs text-text-secondary">
            <span className="sr-only">{messages.chips.statusFilter}</span>
            <Select
              className="h-8 min-w-[6.5rem]"
              value={statusFilter}
              onChange={(value) => setStatusFilter(value as "all" | "active" | "inactive")}
              options={[
                { value: "all", label: messages.chips.allStatuses },
                { value: "active", label: messages.chips.active },
                { value: "inactive", label: messages.chips.inactive },
              ]}
            />
          </div>
        </div>
        <DataGrid
          className="min-h-0 flex-1"
          headers={[...messages.chips.headers]}
          columnWidths={[56, 200, 88, 72, 88, 140]}
        >
          {loading ? (
            <EmptyGridRow cols={6} text={messages.common.loading} />
          ) : chips.length === 0 ? (
            <EmptyGridRow cols={6} text={messages.workspace.noWorkspaces} />
          ) : visibleChips.length === 0 ? (
            <EmptyGridRow cols={6} text={messages.chips.filterEmpty} />
          ) : (
            visibleChips.map((chip) => (
              <GridRow key={chip.id} selected={selectedSet.has(chip.id)}>
                <GridCell>
                  <input
                    className="field-control"
                    type="checkbox"
                    checked={selectedSet.has(chip.id)}
                    disabled={busy}
                    aria-label={chip.name}
                    onChange={() => toggleOne(chip.id)}
                  />
                </GridCell>
                <GridCell>
                  <button
                    type="button"
                    className="truncate text-left font-medium text-accent hover:underline"
                    onClick={() => setDetail(chip)}
                  >
                    {chip.name}
                  </button>
                </GridCell>
                <GridCell>{kindLabel(chip.kind, messages)}</GridCell>
                <GridCell mono muted>
                  v{chip.revision}
                </GridCell>
                <GridCell>
                  <button
                    type="button"
                    className={cn(
                      "text-xs font-semibold outline-none hover:underline",
                      chip.active ? "text-success" : "text-text-tertiary",
                    )}
                    disabled={busy}
                    onClick={() => void toggleActive(chip)}
                  >
                    {chip.active ? messages.chips.active : messages.chips.inactive}
                  </button>
                </GridCell>
                <GridCell mono muted>{fmtWhen(chip.updated_at)}</GridCell>
              </GridRow>
            ))
          )}
        </DataGrid>
      </Panel>

      <AppDialog
        open={Boolean(detail)}
        title={detail?.name ?? ""}
        icon={
          <Puzzle
            className={cn(
              "size-4",
              detail?.kind === "transform" ? "text-success" : detail?.kind === "load" ? "text-warning" : "text-accent",
            )}
            aria-hidden="true"
          />
        }
        className="w-[min(40rem,94vw)]"
        minWidth={380}
        minHeight={320}
        onClose={() => setDetail(null)}
        headerExtra={
          <div className="flex flex-1 justify-end">
            <button
              type="button"
              className="grid size-8 shrink-0 place-items-center rounded-lg text-text-secondary outline-none transition-colors hover:bg-subtle hover:text-text focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45"
              aria-label={messages.common.edit}
              title={`${messages.common.edit} (${messages.common.comingSoon})`}
              disabled
            >
              <Pencil className="size-4" aria-hidden="true" />
            </button>
          </div>
        }
      >
        {detail ? (
          <div className="flex flex-col gap-4 p-4">
            <dl className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <dt className="text-text-tertiary">{messages.workspace.chipName}</dt>
                <dd className="mt-1 font-medium text-text">{detail.name}</dd>
              </div>
              <div>
                <dt className="text-text-tertiary">{messages.chips.headers[2]}</dt>
                <dd className="mt-1 font-medium text-text">{kindLabel(detail.kind, messages)}</dd>
              </div>
            </dl>
            <ChipDetailView chip={detail} />
          </div>
        ) : null}
      </AppDialog>
    </PageShell>
  );
}
