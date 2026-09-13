import { useEffect, useMemo, useState } from "react";
import { Terminal } from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { SqlEditor } from "@/components/query/SqlEditor";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { PaneHeader } from "@/components/ui/pane-header";
import { useConnections } from "@/hooks/connections/useConnections";
import { useLanguage } from "@/i18n/LanguageProvider";
import { layout } from "@/lib/layout";
import { cn } from "@/lib/cn";
import { selectableClass } from "@/lib/selectable";
import { SplitLayout } from "@/layouts/SplitLayout";
import { chipApi } from "@/services/chips/chipApi";
import { isChipNameConflict } from "@/services/httpClient";
import { toastError, toastSuccess } from "@/lib/notifications";
import type { Chip } from "@/types/chip";

const SQL_PLACEHOLDER = "TRUNCATE TABLE test";

function sqlConfig(chip: Chip | null) {
  const config = chip?.config ?? {};
  const connectionId = typeof config.connection_id === "string" ? config.connection_id : "";
  const sqlText = typeof config.sql_text === "string" ? config.sql_text : "";
  const database = typeof config.database === "string" ? config.database : "";
  return { connectionId, sqlText, database };
}

export function SqlChipEditorDialog({
  open,
  workspaceId,
  chip,
  defaultName,
  occupiedNames,
  onClose,
  onSaved,
}: {
  open: boolean;
  workspaceId?: string;
  chip: Chip | null;
  defaultName: string;
  occupiedNames: string[];
  onClose: () => void;
  onSaved: (chip: Chip) => void;
}) {
  const { messages } = useLanguage();
  const { connections } = useConnections();
  const dbConnections = useMemo(
    () => connections.filter((connection) => connection.driver !== "http"),
    [connections],
  );
  const editing = Boolean(chip);
  const [name, setName] = useState(defaultName);
  const [connectionId, setConnectionId] = useState("");
  const [sqlText, setSqlText] = useState("");
  const [database, setDatabase] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const saved = sqlConfig(chip);
    setName((chip?.name ?? defaultName).trim() || defaultName);
    setConnectionId(saved.connectionId);
    setSqlText(saved.sqlText);
    setDatabase(saved.database);
  }, [chip, defaultName, open]);

  const active = dbConnections.find((connection) => connection.id === connectionId);
  const nameTaken = occupiedNames.some(
    (value) =>
      value.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase()
      && value.trim().toLocaleLowerCase() !== (chip?.name ?? "").trim().toLocaleLowerCase(),
  );
  const canSave =
    Boolean(name.trim())
    && Boolean(connectionId)
    && Boolean(sqlText.trim())
    && !nameTaken
    && (editing || Boolean(workspaceId));

  async function save() {
    if (!canSave || busy) return;
    setBusy(true);
    const config = {
      connection_id: connectionId,
      sql_text: sqlText,
      database: database.trim() || undefined,
    };
    try {
      const saved = editing && chip
        ? await chipApi.update(chip.id, { name: name.trim(), config })
        : await chipApi.create(workspaceId!, {
            name: name.trim(),
            kind: "sql",
            config,
          });
      toastSuccess(messages.workspace.sqlChipSaved);
      onSaved(saved);
    } catch (error) {
      toastError(
        isChipNameConflict(error) ? messages.workspace.duplicateChipName : messages.workspace.saveChipError,
        isChipNameConflict(error) ? undefined : error,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppDialog
      open={open}
      title={editing ? messages.workspace.editSqlChipTitle : messages.workspace.placeSqlTitle}
      icon={<Terminal className="size-4 text-sky-600 dark:text-sky-400" aria-hidden="true" />}
      zIndex={130}
      className="flex h-[min(40rem,88vh)] w-[min(64rem,96vw)] max-w-[96vw] flex-col"
      minWidth={640}
      minHeight={420}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            {messages.common.cancel}
          </Button>
          <Button type="button" variant="primary" disabled={busy || !canSave} onClick={() => void save()}>
            {busy ? messages.common.saving : messages.common.save}
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <div className="grid shrink-0 gap-3 sm:grid-cols-2">
          <FormField label={messages.workspace.chipName}>
            <input
              className="field-control text-sm"
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
            {nameTaken ? (
              <span className="text-xs text-danger">{messages.workspace.duplicateChipName}</span>
            ) : null}
          </FormField>
          <FormField label={messages.workspace.database} hint={messages.workspace.sqlDatabaseHint}>
            <input
              className="field-control text-sm"
              value={database}
              disabled={busy || !connectionId}
              placeholder={active?.database_name ?? ""}
              onChange={(event) => setDatabase(event.target.value)}
            />
          </FormField>
        </div>
        <SplitLayout className="min-h-0 flex-1" defaultSizes={[layout.split.connections + 40]}>
          <aside className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface">
            <PaneHeader
              title={messages.common.connections}
              meta={messages.common.count(dbConnections.length)}
            />
            <div className="scroll-pane min-h-0 flex-1 overflow-y-auto">
              {dbConnections.length === 0 ? (
                <p className="p-3 text-xs text-text-tertiary">{messages.empty.connections}</p>
              ) : (
                dbConnections.map((connection) => (
                  <button
                    key={connection.id}
                    type="button"
                    disabled={busy}
                    title={connection.name}
                    className={cn(
                      "block w-full min-w-0 overflow-hidden border-b border-border px-3 py-2 text-left last:border-b-0",
                      selectableClass(connection.id === connectionId),
                    )}
                    onClick={() => setConnectionId(connection.id)}
                  >
                    <span className="block truncate text-[13px] text-text">{connection.name}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-text-tertiary">
                      {connection.driver} · {connection.database_name}
                    </span>
                  </button>
                ))
              )}
            </div>
          </aside>
          <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface">
            <PaneHeader title={messages.workspace.sql} description={messages.workspace.sqlEditorHint} />
            <div className="relative min-h-0 flex-1">
              <SqlEditor
                value={sqlText}
                placeholder={SQL_PLACEHOLDER}
                disabled={busy || !connectionId}
                driver={active?.driver}
                onChange={setSqlText}
              />
            </div>
          </section>
        </SplitLayout>
      </div>
    </AppDialog>
  );
}
