import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil, Puzzle, RefreshCw, Trash2 } from "lucide-react";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { AppDialog } from "@/components/AppDialog";
import { PageHeader, PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { useLanguage } from "@/i18n/LanguageProvider";
import { cn } from "@/lib/cn";
import { fmtWhen } from "@/lib/format";
import { showConfirm, toastError } from "@/lib/notifications";
import { chipApi } from "@/services/chipApi";
import type { Chip, ChipKind } from "@/types/chip";

function kindLabel(kind: ChipKind, messages: ReturnType<typeof useLanguage>["messages"]) {
  if (kind === "extract") return messages.workspace.extract;
  if (kind === "transform") return messages.workspace.transform;
  return messages.workspace.load;
}

function bindingSummary(chip: Chip) {
  if (!chip.binding) return "—";
  return `${chip.binding.ref_kind} · ${chip.binding.ref_id.slice(0, 8)}`;
}

export function ChipsPage() {
  const { messages } = useLanguage();
  const [chips, setChips] = useState<Chip[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<Chip | null>(null);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const allSelected = chips.length > 0 && selected.length === chips.length;

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

  const activeCount = useMemo(() => chips.filter((chip) => chip.active).length, [chips]);

  function toggleOne(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  function toggleAll() {
    setSelected(allSelected ? [] : chips.map((chip) => chip.id));
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
                disabled={chips.length === 0 || loading || busy}
                onChange={toggleAll}
                aria-label={messages.chips.selectAll}
              />
              <span>{messages.workspace.chipCatalog}</span>
            </label>
            <span className="text-xs text-text-tertiary">
              {messages.common.cases(chips.length)} · {messages.chips.active} {activeCount}
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
        <DataGrid
          className="min-h-0 flex-1"
          headers={[...messages.chips.headers]}
          columnWidths={[56, 200, 88, 72, 88, 140]}
        >
          {loading ? (
            <EmptyGridRow cols={6} text={messages.common.loading} />
          ) : chips.length === 0 ? (
            <EmptyGridRow cols={6} text={messages.workspace.noWorkspaces} />
          ) : (
            chips.map((chip) => (
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
        icon={<Puzzle className="size-4 text-accent" aria-hidden="true" />}
        className="w-[min(36rem,94vw)]"
        minWidth={360}
        minHeight={280}
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
          <div className="flex flex-col gap-3 p-4 text-sm">
            <dl className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <dt className="text-text-tertiary">{messages.workspace.chipName}</dt>
                <dd className="mt-1 font-medium text-text">{detail.name}</dd>
              </div>
              <div>
                <dt className="text-text-tertiary">{messages.chips.headers[2]}</dt>
                <dd className="mt-1 font-medium text-text">{kindLabel(detail.kind, messages)}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-text-tertiary">{messages.chips.binding}</dt>
                <dd className="mt-1 font-mono text-[12px] text-text-secondary">
                  {bindingSummary(detail)}
                </dd>
              </div>
            </dl>
            <pre className="scroll-pane max-h-64 overflow-auto rounded-lg border border-border bg-subtle/40 p-3 text-[11px] leading-relaxed text-text-secondary">
              {JSON.stringify(detail.config, null, 2)}
            </pre>
          </div>
        ) : null}
      </AppDialog>
    </PageShell>
  );
}
