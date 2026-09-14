import { useEffect, useMemo, useRef, useState } from "react";
import { BookmarkPlus, Terminal } from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { CatalogTree, type CatalogSchemaPick } from "@/components/connections/CatalogTree";
import { SqlEditor } from "@/components/query/SqlEditor";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { PaneHeader } from "@/components/ui/pane-header";
import { useConnectionColumns } from "@/hooks/connections/useConnectionColumns";
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
import type { CatalogSelection } from "@/types/connection";

const SQL_PLACEHOLDER = "TRUNCATE TABLE test";

function sqlConfig(chip: Chip | null) {
  const config = chip?.config ?? {};
  const connectionId = typeof config.connection_id === "string" ? config.connection_id : "";
  const sqlText = typeof config.sql_text === "string" ? config.sql_text : "";
  const database = typeof config.database === "string" ? config.database : "";
  const schema = typeof config.schema === "string" ? config.schema : "";
  return { connectionId, sqlText, database, schema };
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
  const [naming, setNaming] = useState(false);
  const [connectionId, setConnectionId] = useState("");
  const [sqlText, setSqlText] = useState("");
  const [database, setDatabase] = useState("");
  const [schemaPick, setSchemaPick] = useState<CatalogSchemaPick | null>(null);
  const [selected, setSelected] = useState<CatalogSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const { connectionColumns } = useConnectionColumns(
    connectionId,
    selected?.table ? selected : null,
  );

  useEffect(() => {
    if (!open) return;
    const saved = sqlConfig(chip);
    setNaming(false);
    setName((chip?.name ?? defaultName).trim() || defaultName);
    setConnectionId(saved.connectionId);
    setSqlText(saved.sqlText);
    setDatabase(saved.database);
    setSchemaPick(
      saved.database && saved.schema
        ? { database: saved.database, schema: saved.schema }
        : saved.schema
          ? { database: "", schema: saved.schema }
          : null,
    );
    setSelected(null);
  }, [chip, defaultName, open]);

  const active = dbConnections.find((connection) => connection.id === connectionId);
  const schema = schemaPick?.schema || selected?.schema || "";
  const contextLabel = [database || active?.database_name, schema].filter(Boolean).join(" · ")
    || messages.workspace.sqlContextUnset;
  const nameTaken = occupiedNames.some(
    (value) =>
      value.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase()
      && value.trim().toLocaleLowerCase() !== (chip?.name ?? "").trim().toLocaleLowerCase(),
  );
  const canConfigure =
    Boolean(connectionId)
    && Boolean(sqlText.trim())
    && (editing || Boolean(workspaceId));
  const canSave = canConfigure && Boolean(name.trim()) && !nameTaken;

  function pickConnection(id: string) {
    setConnectionId(id);
    setSelected(null);
    setSchemaPick(null);
    setDatabase("");
  }

  function openNaming() {
    if (busy || !canConfigure) return;
    setName((current) => current.trim() || chip?.name?.trim() || defaultName);
    setNaming(true);
  }

  async function save() {
    if (!canSave || busy) return;
    setBusy(true);
    const config = {
      connection_id: connectionId,
      sql_text: sqlText,
      database: database.trim() || undefined,
      schema: schema.trim() || undefined,
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
      setNaming(false);
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

  const namingRef = useRef(naming);
  const openNamingRef = useRef(openNaming);
  const saveRef = useRef(save);
  namingRef.current = naming;
  openNamingRef.current = openNaming;
  saveRef.current = save;

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (namingRef.current) {
        void saveRef.current();
        return;
      }
      openNamingRef.current();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  return (
    <>
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
          <Button
            type="button"
            className="gap-2"
            disabled={busy || !canConfigure}
            onClick={openNaming}
          >
            <BookmarkPlus className="size-3.5" aria-hidden="true" />
            {editing ? messages.query.applyChip : messages.query.registerTask}
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-surface">
          <SplitLayout className="h-full" defaultSizes={[layout.split.connections + 48]} insetGutter>
            <aside className="flex h-full min-h-0 flex-col overflow-hidden">
              <SplitLayout
                direction="vertical"
                className="h-full"
                defaultSizes={[layout.split.minStack + 48]}
                minSize={layout.split.minStack}
                insetGutter
              >
                <div className="flex h-full min-h-0 flex-col overflow-hidden">
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
                          onClick={() => pickConnection(connection.id)}
                        >
                          <span className="block truncate text-[13px] text-text">{connection.name}</span>
                          <span className="mt-0.5 block truncate text-[11px] text-text-tertiary">
                            {connection.driver} · {connection.database_name}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
                <div className="flex h-full min-h-0 flex-col overflow-hidden">
                  <PaneHeader title={messages.common.catalog} />
                  <div className="scroll-pane min-h-0 flex-1 overflow-y-auto">
                    {connectionId ? (
                      <CatalogTree
                        connectionId={connectionId}
                        selected={selected}
                        selectedSchema={schemaPick}
                        onPick={(pick) => {
                          setSelected(pick);
                          if (pick) {
                            setDatabase(pick.database);
                            setSchemaPick(
                              pick.schema ? { database: pick.database, schema: pick.schema } : null,
                            );
                          }
                        }}
                        onPickSchema={(pick) => {
                          setSchemaPick(pick);
                          setSelected(null);
                          if (pick) setDatabase(pick.database);
                        }}
                      />
                    ) : (
                      <p className="p-3 text-xs text-text-tertiary">{messages.empty.query}</p>
                    )}
                  </div>
                </div>
              </SplitLayout>
            </aside>
            <section className="flex h-full min-h-0 flex-col overflow-hidden">
              <PaneHeader title={messages.workspace.sql} description={contextLabel} />
              <div className="relative min-h-0 flex-1">
                <SqlEditor
                  value={sqlText}
                  placeholder={SQL_PLACEHOLDER}
                  disabled={busy || !connectionId}
                  driver={active?.driver}
                  table={selected?.qualified}
                  columns={connectionColumns}
                  onChange={setSqlText}
                />
              </div>
            </section>
          </SplitLayout>
        </div>
      </div>
    </AppDialog>

    <AppDialog
      open={open && naming}
      title={editing ? messages.query.applyChip : messages.query.registerTaskTitle}
      icon={<BookmarkPlus className="size-4 text-accent" aria-hidden="true" />}
      className="w-[min(22rem,92vw)]"
      minWidth={320}
      minHeight={240}
      zIndex={140}
      defaultOffset={{ x: 40, y: 28 }}
      onClose={() => setNaming(false)}
      footer={
        <>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => setNaming(false)}>
            {messages.common.cancel}
          </Button>
          <Button type="button" variant="primary" disabled={busy || !canSave} onClick={() => void save()}>
            {busy ? messages.common.saving : messages.common.save}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-4">
        <p className="text-[11px] leading-5 text-text-tertiary">
          {editing ? messages.workspace.editSqlHint : messages.workspace.registerSqlHint}
        </p>
        <FormField label={messages.workspace.chipName}>
          <input
            className="field-control"
            value={name}
            autoFocus
            disabled={busy}
            placeholder={messages.query.namePlaceholder}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void save();
            }}
          />
          {nameTaken ? (
            <span className="text-xs text-danger">{messages.workspace.duplicateChipName}</span>
          ) : null}
        </FormField>
        <dl className="space-y-2 border-t border-border/60 pt-3 text-[11px] text-text-tertiary">
          <div className="flex gap-2">
            <dt className="w-14 shrink-0">{messages.workspace.connection}</dt>
            <dd className="min-w-0 truncate text-text-secondary">{active?.name ?? "—"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-14 shrink-0">{messages.workspace.sql}</dt>
            <dd className="line-clamp-3 min-w-0 font-mono text-[10px] leading-4 text-text-secondary">
              {sqlText.trim() || "—"}
            </dd>
          </div>
        </dl>
      </div>
    </AppDialog>
    </>
  );
}
