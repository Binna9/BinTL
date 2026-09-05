import { useEffect, useMemo, useState } from "react";
import { Database, FileOutput, Plus, Save, Trash2 } from "lucide-react";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Select } from "@/components/ui/select";
import { useLanguage } from "@/i18n/LanguageProvider";
import { showConfirm, toastError, toastSuccess } from "@/lib/notifications";
import { connectionApi } from "@/services/connections/connectionApi";
import { chipApi } from "@/services/chips/chipApi";
import { loadApi } from "@/services/load/loadApi";
import type { DataConnection } from "@/types/connection";
import type { LoadDefinition, LoadSpec } from "@/types/load";

export function LoadPage() {
  const { messages } = useLanguage();
  const t = messages.load;
  const [loads, setLoads] = useState<LoadDefinition[]>([]);
  const [connections, setConnections] = useState<DataConnection[]>([]);
  const [editingId, setEditingId] = useState<string>();
  const [name, setName] = useState("");
  const [destinationType, setDestinationType] = useState<"database" | "file">("database");
  const [connectionId, setConnectionId] = useState("");
  const [table, setTable] = useState("");
  const [format, setFormat] = useState<"csv" | "parquet">("parquet");
  const [filename, setFilename] = useState("result.parquet");
  const [writeMode, setWriteMode] = useState<"append" | "replace">("append");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const [loadResponse, connectionResponse] = await Promise.all([loadApi.list(), connectionApi.getConnections()]);
      setLoads(loadResponse.loads);
      setConnections(connectionResponse.connections.filter((item) => item.driver !== "http"));
    } catch (error) { toastError(t.loadError, error); }
  }

  useEffect(() => { void refresh(); }, []);

  const spec = useMemo<LoadSpec>(() => destinationType === "database"
    ? { destination: { type: "database", connection_id: connectionId, table }, write_mode: writeMode }
    : { destination: { type: "file", format, filename }, write_mode: "replace" },
  [connectionId, destinationType, filename, format, table, writeMode]);

  function reset() {
    setEditingId(undefined); setName(""); setDestinationType("database"); setConnectionId("");
    setTable(""); setFormat("parquet"); setFilename("result.parquet"); setWriteMode("append");
  }

  function edit(load: LoadDefinition) {
    setEditingId(load.id); setName(load.name); setDestinationType(load.destination_type); setWriteMode(load.spec.write_mode);
    if (load.spec.destination.type === "database") {
      setConnectionId(load.spec.destination.connection_id); setTable(load.spec.destination.table);
    } else { setFormat(load.spec.destination.format); setFilename(load.spec.destination.filename); }
  }

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      if (editingId) await loadApi.update(editingId, { name: name.trim(), spec });
      else await loadApi.create({ name: name.trim(), spec });
      toastSuccess(t.saved); reset(); await refresh();
    } catch (error) { toastError(t.saveError, error); } finally { setBusy(false); }
  }

  async function register(load: LoadDefinition) {
    setBusy(true);
    try {
      await chipApi.register({ name: load.name, kind: "load", load_definition_id: load.id, run_after: false });
      toastSuccess(t.chipRegistered);
    } catch (error) { toastError(t.registerError, error); } finally { setBusy(false); }
  }

  async function remove(load: LoadDefinition) {
    if (!await showConfirm(t.deleteTitle, t.deleteMessage)) return;
    try { await loadApi.remove(load.id); toastSuccess(t.deleted); if (editingId === load.id) reset(); await refresh(); }
    catch (error) { toastError(t.deleteError, error); }
  }

  const canSave = Boolean(name.trim() && (destinationType === "database" ? connectionId && table.trim() : filename.trim()));

  return (
    <PageShell>
      <PageHeader iconName="jobs" eyebrow={t.eyebrow} title={t.title} description={t.description} />
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(20rem,0.85fr)_minmax(28rem,1.4fr)]">
        <Panel tall>
          <PanelHeader title={t.definitions} actions={<Button variant="quiet" onClick={reset}><Plus className="size-4" />{t.newDefinition}</Button>} />
          <PanelBody className="scroll-pane min-h-0 flex-1 overflow-auto p-2">
            {loads.length === 0 ? <p className="p-6 text-center text-sm text-text-tertiary">{t.empty}</p> : <ul className="space-y-2">{loads.map((load) => (
              <li key={load.id} className="rounded-xl border border-border bg-raised p-3">
                <button className="flex w-full items-start gap-3 text-left" onClick={() => edit(load)}>
                  <span className="grid size-9 place-items-center rounded-lg bg-accent-subtle text-accent">{load.destination_type === "database" ? <Database className="size-4" /> : <FileOutput className="size-4" />}</span>
                  <span className="min-w-0 flex-1"><strong className="block truncate text-sm">{load.name}</strong><span className="mt-1 block truncate text-xs text-text-secondary">{load.spec.destination.type === "database" ? load.spec.destination.table : load.spec.destination.filename}</span></span>
                </button>
                <div className="mt-3 flex justify-end gap-1.5"><Button variant="secondary" disabled={busy} onClick={() => void register(load)}>{t.registerChip}</Button><Button variant="quiet" disabled={busy} onClick={() => void remove(load)}><Trash2 className="size-3.5" /></Button></div>
              </li>
            ))}</ul>}
          </PanelBody>
        </Panel>
        <Panel tall>
          <PanelHeader title={editingId ? t.editDefinition : t.newDefinition} description={t.formHint} />
          <PanelBody className="scroll-pane min-h-0 flex-1 overflow-auto">
            <div className="mx-auto grid max-w-2xl gap-5">
              <FormField label={t.name}><input className="field-control" value={name} onChange={(e) => setName(e.target.value)} placeholder={t.namePlaceholder} /></FormField>
              <FormField label={t.destinationType}><Select value={destinationType} onChange={(v) => setDestinationType(v as "database" | "file")} options={[{ value: "database", label: t.database }, { value: "file", label: t.file }]} /></FormField>
              {destinationType === "database" ? <>
                <FormField label={t.connection}><Select value={connectionId} placeholder={t.pickConnection} onChange={setConnectionId} options={connections.map((item) => ({ value: item.id, label: `${item.name} · ${item.driver}` }))} /></FormField>
                <FormField label={t.table}><input className="field-control technical" value={table} onChange={(e) => setTable(e.target.value)} placeholder="public.target_table" /></FormField>
                <FormField label={t.writeMode}><Select value={writeMode} onChange={(v) => setWriteMode(v as "append" | "replace")} options={[{ value: "append", label: t.append }, { value: "replace", label: t.replace }]} /></FormField>
              </> : <>
                <FormField label={t.format}><Select value={format} onChange={(v) => { const next = v as "csv" | "parquet"; setFormat(next); setFilename(`result.${next}`); }} options={[{ value: "parquet", label: "Parquet" }, { value: "csv", label: "CSV" }]} /></FormField>
                <FormField label={t.filename}><input className="field-control technical" value={filename} onChange={(e) => setFilename(e.target.value)} /></FormField>
                <p className="rounded-lg border border-border bg-subtle/40 p-3 text-xs leading-5 text-text-secondary">{t.fileHint}</p>
              </>}
              <div className="flex justify-end gap-2 border-t border-border pt-4"><Button variant="secondary" onClick={reset}>{t.reset}</Button><Button variant="primary" disabled={busy || !canSave} onClick={() => void save()}><Save className="size-3.5" />{busy ? messages.common.saving : messages.common.save}</Button></div>
            </div>
          </PanelBody>
        </Panel>
      </div>
    </PageShell>
  );
}
