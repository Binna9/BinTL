import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Check, ChevronRight, Clock3, FolderTree, Pause, Pencil, Play, Plus, Search, Trash2 } from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { WorkspaceTreePicker } from "@/components/workspace/WorkspaceTreePicker";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { useLanguage } from "@/i18n/LanguageProvider";
import { showConfirm, toastError, toastSuccess } from "@/lib/notifications";
import { cn } from "@/lib/cn";
import { scheduleApi } from "@/services/schedule/scheduleApi";
import { workspaceApi } from "@/services/workspace/workspaceApi";
import type { ScheduleRequest, ScheduleUnit, WorkspaceSchedule } from "@/types/schedule";
import type { Workspace, WorkspaceFolder } from "@/types/workspace";

const emptyDraft: ScheduleRequest = { workspace_id: "", name: "", schedule_type: "interval", interval_value: 1, interval_unit: "day", second: 0, hour: 0, minute: 0, day_of_month: 1, month_of_year: 1, enabled: true };
const INTERVAL_LIMITS: Record<ScheduleUnit, { min: number; max: number }> = {
  second: { min: 1, max: 60 }, minute: { min: 1, max: 60 }, hour: { min: 1, max: 24 },
  day: { min: 1, max: 31 }, month: { min: 1, max: 12 }, year: { min: 1, max: 100 },
};

export function SchedulePage() {
  const { messages } = useLanguage();
  const t = messages.schedule;
  const [schedules, setSchedules] = useState<WorkspaceSchedule[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [folders, setFolders] = useState<WorkspaceFolder[]>([]);
  const [editing, setEditing] = useState<WorkspaceSchedule | null>(null);
  const [draft, setDraft] = useState<ScheduleRequest>(emptyDraft);
  const [intervalInput, setIntervalInput] = useState("1");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [workspaceSearch, setWorkspaceSearch] = useState("");

  async function refresh() {
    try {
      const [a, b, c] = await Promise.all([scheduleApi.list(), workspaceApi.list(), workspaceApi.listFolders()]);
      setSchedules(a.schedules); setWorkspaces(b.workspaces); setFolders(c.folders);
    } catch (error) { toastError(t.loadError, error); }
  }
  useEffect(() => { void refresh(); }, []);
  const workspaceNames = useMemo(() => new Map(workspaces.map((row) => [row.id, row.name])), [workspaces]);
  const intervalLimit = INTERVAL_LIMITS[draft.interval_unit];
  const parsedInterval = /^\d+$/.test(intervalInput) ? Number(intervalInput) : Number.NaN;
  const intervalValid = Number.isInteger(parsedInterval)
    && parsedInterval >= intervalLimit.min && parsedInterval <= intervalLimit.max;
  const valid = Boolean(draft.workspace_id && draft.name.trim()
    && intervalValid
    && (!(["month", "year"] as ScheduleUnit[]).includes(draft.interval_unit)
      || ((draft.day_of_month ?? 0) >= 1 && (draft.day_of_month ?? 0) <= 31))
    && (draft.interval_unit !== "year"
      || ((draft.month_of_year ?? 0) >= 1 && (draft.month_of_year ?? 0) <= 12)));

  function beginCreate() { setEditing(null); setDraft({ ...emptyDraft, workspace_id: workspaces[0]?.id ?? "" }); setIntervalInput("1"); setOpen(true); }
  function beginEdit(row: WorkspaceSchedule) {
    setEditing(row); setDraft({ workspace_id: row.workspace_id, name: row.name, schedule_type: row.schedule_type,
      interval_value: row.interval_value, interval_unit: row.interval_unit, second: row.second ?? 0,
      hour: row.hour ?? 0, minute: row.minute ?? 0, day_of_month: row.day_of_month ?? 1,
      month_of_year: row.month_of_year ?? 1, enabled: row.enabled }); setIntervalInput(String(row.interval_value)); setOpen(true);
  }
  function requestFor(row: WorkspaceSchedule, enabled = row.enabled): ScheduleRequest {
    return { workspace_id: row.workspace_id, name: row.name, schedule_type: row.schedule_type,
      interval_value: row.interval_value, interval_unit: row.interval_unit, second: row.second ?? undefined,
      hour: row.hour ?? undefined, minute: row.minute ?? undefined, day_of_month: row.day_of_month ?? undefined,
      month_of_year: row.month_of_year ?? undefined, enabled };
  }
  async function save() {
    if (!valid) return; setBusy(true);
    const request = { ...draft, interval_value: parsedInterval };
    try { if (editing) await scheduleApi.update(editing.id, request); else await scheduleApi.create(request);
      setOpen(false); await refresh(); toastSuccess(t.saved); }
    catch (error) { toastError(t.saveError, error); } finally { setBusy(false); }
  }
  async function toggle(row: WorkspaceSchedule) {
    try { await scheduleApi.update(row.id, requestFor(row, !row.enabled)); await refresh(); }
    catch (error) { toastError(t.saveError, error); }
  }
  async function remove(row: WorkspaceSchedule) {
    if (!await showConfirm(t.deleteTitle, t.deleteMessage, { confirmLabel: messages.common.delete })) return;
    try { await scheduleApi.remove(row.id); await refresh(); toastSuccess(t.deleted); }
    catch (error) { toastError(t.deleteError, error); }
  }
  function cadence(row: WorkspaceSchedule) {
    const interval = t.everyInterval(row.interval_value, t.units[row.interval_unit]);
    if (!["day", "month", "year"].includes(row.interval_unit)) return interval;
    const time = `${String(row.hour ?? 0).padStart(2, "0")}:${String(row.minute ?? 0).padStart(2, "0")}:${String(row.second ?? 0).padStart(2, "0")}`;
    const calendar = row.interval_unit === "year" ? `${t.monthValue(row.month_of_year ?? 1)} ${row.day_of_month ?? 1}${t.daySuffix}`
      : row.interval_unit === "month" ? `${row.day_of_month ?? 1}${t.daySuffix}` : "";
    return [interval, calendar, time].filter(Boolean).join(" · ");
  }

  const selectedWorkspace = workspaces.find((row) => row.id === draft.workspace_id);
  const filteredWorkspaces = workspaceSearch.trim() ? workspaces.filter((row) => row.name.toLocaleLowerCase().includes(workspaceSearch.trim().toLocaleLowerCase())) : workspaces;
  const usesTime = (["day", "month", "year"] as ScheduleUnit[]).includes(draft.interval_unit);

  return <PageShell>
    <PageHeader iconName="schedule" eyebrow={t.eyebrow} title={t.title} description={t.description}
      actions={<Button onClick={beginCreate} disabled={!workspaces.length}><Plus className="size-4" />{t.newSchedule}</Button>} />
    <Panel tall><PanelHeader title={t.listTitle} actions={<span className="text-xs text-text-tertiary">{messages.common.count(schedules.length)}</span>} />
      <PanelBody className="min-h-0 flex-1 overflow-auto bg-raised p-4">
        {!schedules.length ? <div className="grid min-h-64 place-items-center text-center"><div><CalendarClock className="mx-auto size-10 text-text-tertiary" /><p className="mt-3 text-sm font-semibold">{t.empty}</p><p className="mt-1 text-xs text-text-tertiary">{t.emptyHint}</p></div></div>
          : <div className="grid gap-3 xl:grid-cols-2">{schedules.map((row) => <article key={row.id} className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
            <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-subtle text-accent"><CalendarClock className="size-5" /></span>
              <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h2 className="truncate text-sm font-semibold">{row.name}</h2><span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${row.enabled ? "bg-success/10 text-success" : "bg-subtle text-text-tertiary"}`}>{row.enabled ? t.active : t.paused}</span></div><p className="mt-1 truncate text-xs text-text-secondary">{workspaceNames.get(row.workspace_id) ?? row.workspace_id}</p></div>
              <div className="flex gap-1"><Button variant="quiet" onClick={() => void toggle(row)}>{row.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}</Button><Button variant="quiet" onClick={() => beginEdit(row)}><Pencil className="size-3.5" /></Button><Button variant="quiet" onClick={() => void remove(row)}><Trash2 className="size-3.5" /></Button></div></div>
            <div className="mt-4 grid grid-cols-2 gap-3 rounded-xl bg-raised p-3 text-xs"><div><p className="text-text-tertiary">{t.cadence}</p><p className="mt-1 font-medium">{cadence(row)}</p></div><div><p className="text-text-tertiary">{t.nextRun}</p><p className="mt-1 font-medium">{row.enabled ? new Date(row.next_run_at).toLocaleString() : "—"}</p></div></div>
          </article>)}</div>}
      </PanelBody></Panel>
    <AppDialog open={open} title={editing ? t.editSchedule : t.newSchedule} icon={<CalendarClock className="size-4 text-accent" />} onClose={() => setOpen(false)} className="w-[min(32rem,94vw)]"
      footer={<><Button variant="quiet" onClick={() => setOpen(false)}>{messages.common.cancel}</Button><Button disabled={!valid || busy} onClick={() => void save()}>{busy ? messages.common.saving : messages.common.save}</Button></>}>
      <div className="grid gap-4 p-5">
        <FormField label={t.name}><input className="field-control" autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></FormField>
        <FormField label={t.workspace}>
          <button type="button" className="group flex h-12 w-full items-center gap-3 rounded-xl border border-border bg-surface px-3 text-left shadow-sm transition hover:border-accent/40 hover:bg-accent-subtle/30" onClick={() => { setWorkspaceSearch(""); setWorkspacePickerOpen(true); }}>
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-subtle text-accent"><FolderTree className="size-4" /></span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{selectedWorkspace?.name ?? t.pickWorkspace}</span>
            <ChevronRight className="size-4 text-text-tertiary transition-transform group-hover:translate-x-0.5" />
          </button>
        </FormField>
        <FormField label={t.cadence} hint={t.intervalRange(intervalLimit.min, intervalLimit.max)}>
          <div className="grid grid-cols-2 gap-2">
            <div className={cn("field-control flex items-center overflow-hidden p-0", !intervalValid && intervalInput !== "" && "border-danger focus-within:border-danger focus-within:ring-danger/15")}>
              <input
                type="number"
                inputMode="numeric"
                min={intervalLimit.min}
                max={intervalLimit.max}
                step={1}
                className="min-w-0 flex-1 bg-transparent px-2.5 text-[13px] font-semibold outline-none"
                value={intervalInput}
                onChange={(event) => {
                  const value = event.target.value.replace(/^0+(?=\d)/, "");
                  setIntervalInput(value);
                }}
              />
              <span className="pr-2.5 text-[11px] text-text-tertiary">{t.every}</span>
            </div>
            <Select
              value={draft.interval_unit}
              onChange={(value) => {
                const unit = value as ScheduleUnit;
                const nextLimit = INTERVAL_LIMITS[unit];
                const current = /^\d+$/.test(intervalInput) ? Number(intervalInput) : null;
                setDraft({ ...draft, interval_unit: unit });
                if (current !== null) {
                  setIntervalInput(String(Math.min(nextLimit.max, Math.max(nextLimit.min, current))));
                }
              }}
              options={(Object.keys(t.units) as ScheduleUnit[]).map((unit) => ({ value: unit, label: t.units[unit] }))}
            />
          </div>
        </FormField>
        {draft.interval_unit === "year" ? <FormField label={t.month}><Select value={String(draft.month_of_year ?? 1)} onChange={(value) => setDraft({ ...draft, month_of_year: Number(value) })} options={Array.from({ length: 12 }, (_, index) => ({ value: String(index + 1), label: t.monthValue(index + 1) }))} /></FormField> : null}
        {(["month", "year"] as ScheduleUnit[]).includes(draft.interval_unit) ? <FormField label={t.day}><input type="number" min={1} max={31} className="field-control" value={draft.day_of_month ?? 1} onChange={(e) => setDraft({ ...draft, day_of_month: Number(e.target.value) })} /></FormField> : null}
        {usesTime ? <FormField label={t.time} hint={t.timeHint}>
          <div className="group relative flex h-16 cursor-pointer items-center gap-3 overflow-hidden rounded-2xl border border-border-strong bg-gradient-to-r from-surface to-accent-subtle/35 px-4 shadow-sm transition hover:border-accent/50 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/10" onClick={(event) => { const input = event.currentTarget.querySelector("input"); input?.showPicker?.(); }}>
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-white shadow-sm"><Clock3 className="size-5" /></span>
            <div className="min-w-0 flex-1"><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-tertiary">Asia/Seoul</p><p className="mt-0.5 font-mono text-xl font-bold tabular-nums text-text">{`${String(draft.hour ?? 0).padStart(2, "0")}:${String(draft.minute ?? 0).padStart(2, "0")}:${String(draft.second ?? 0).padStart(2, "0")}`}</p></div>
            <input type="time" step={1} className="absolute inset-0 cursor-pointer opacity-0" value={`${String(draft.hour ?? 0).padStart(2, "0")}:${String(draft.minute ?? 0).padStart(2, "0")}:${String(draft.second ?? 0).padStart(2, "0")}`} onChange={(e) => { const [hour, minute, second = 0] = e.target.value.split(":").map(Number); setDraft({ ...draft, hour, minute, second }); }} />
          </div>
        </FormField> : null}
        <p className="rounded-xl border border-border bg-subtle/40 p-3 text-xs text-text-secondary">{t.policyHint}</p>
      </div>
    </AppDialog>
    <AppDialog open={workspacePickerOpen} title={t.pickWorkspace} icon={<FolderTree className="size-4 text-accent" />} zIndex={140} onClose={() => setWorkspacePickerOpen(false)} className="h-[min(40rem,88vh)] w-[min(38rem,94vw)]" minHeight={420}>
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <div className="flex h-11 shrink-0 items-center overflow-hidden rounded-xl border border-border bg-surface shadow-sm focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/10"><span className="grid h-full w-11 place-items-center border-r border-border bg-raised text-text-tertiary"><Search className="size-4" /></span><input className="min-w-0 flex-1 bg-transparent px-3 text-sm outline-none" value={workspaceSearch} onChange={(e) => setWorkspaceSearch(e.target.value)} placeholder={t.searchWorkspace} autoFocus /></div>
        {workspaceSearch.trim() ? <div className="scroll-pane min-h-0 flex-1 space-y-1 overflow-y-auto rounded-2xl border border-border bg-surface p-2">
          {filteredWorkspaces.map((workspace) => <button key={workspace.id} type="button" className="flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left transition hover:bg-accent-subtle" onClick={() => { setDraft({ ...draft, workspace_id: workspace.id }); setWorkspacePickerOpen(false); }}><span className="grid size-7 place-items-center rounded-lg bg-accent-subtle text-accent"><FolderTree className="size-3.5" /></span><span className="min-w-0 flex-1 truncate text-sm font-medium">{workspace.name}</span>{workspace.id === draft.workspace_id ? <Check className="size-4 text-accent" /> : null}</button>)}
          {!filteredWorkspaces.length ? <p className="py-12 text-center text-xs text-text-tertiary">{t.noWorkspaceResults}</p> : null}
        </div> : <WorkspaceTreePicker folders={folders} workspaces={workspaces} value={draft.workspace_id} showSelectionPath={false} className="min-h-0 flex-1" onChange={(workspaceId) => { setDraft({ ...draft, workspace_id: workspaceId }); setWorkspacePickerOpen(false); }} />}
        {selectedWorkspace ? <div className="flex shrink-0 items-center gap-2 rounded-xl border border-accent/20 bg-accent-subtle/40 px-3 py-2 text-xs text-accent"><Check className="size-3.5" />{t.selectedWorkspace(selectedWorkspace.name)}</div> : null}
      </div>
    </AppDialog>
  </PageShell>;
}
