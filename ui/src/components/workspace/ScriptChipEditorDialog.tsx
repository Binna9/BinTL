import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { indentWithTab } from "@codemirror/commands";
import { Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { BookmarkPlus, Braces } from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { PaneHeader } from "@/components/ui/pane-header";
import { useTheme } from "@/hooks/theme/useTheme";
import { useLanguage } from "@/i18n/LanguageProvider";
import { chipApi } from "@/services/chips/chipApi";
import { isChipNameConflict } from "@/services/httpClient";
import { toastError, toastSuccess } from "@/lib/notifications";
import type { Chip } from "@/types/chip";

export const DEFAULT_SCRIPT_MAIN = "function main(ctx) {\n  ctx.write(ctx.input() ?? []);\n}\n";

function scriptSource(chip: Chip | null) {
  const config = chip?.config ?? {};
  const entry = typeof config.entry === "string" && config.entry.trim() ? config.entry : "main.js";
  if (config.files && typeof config.files === "object" && !Array.isArray(config.files)) {
    const source = (config.files as Record<string, unknown>)[entry];
    if (typeof source === "string") return source;
  }
  return DEFAULT_SCRIPT_MAIN;
}

export function ScriptChipEditorDialog({
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
  const { theme } = useTheme();
  const editing = Boolean(chip);
  const [name, setName] = useState(defaultName);
  const [naming, setNaming] = useState(false);
  const [source, setSource] = useState(DEFAULT_SCRIPT_MAIN);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setNaming(false);
    setName((chip?.name ?? defaultName).trim() || defaultName);
    setSource(scriptSource(chip));
    setBusy(false);
  }, [chip, defaultName, open]);

  const nameTaken = occupiedNames.some(
    (value) => value.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase() && value !== chip?.name,
  );
  const canConfigure = Boolean(source.trim()) && (editing || Boolean(workspaceId));
  const canSave = canConfigure && Boolean(name.trim()) && !nameTaken;

  function openNaming() {
    if (busy || !canConfigure) return;
    setName((current) => current.trim() || chip?.name?.trim() || defaultName);
    setNaming(true);
  }

  async function save() {
    if (!canSave || busy) return;
    setBusy(true);
    const config = { entry: "main.js", files: { "main.js": source } };
    try {
      const saved = editing && chip
        ? await chipApi.update(chip.id, { name: name.trim(), config })
        : await chipApi.create(workspaceId!, { name: name.trim(), kind: "script", config });
      toastSuccess(messages.workspace.scriptChipSaved);
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

  const extensions = useMemo(
    () => [
      javascript(),
      EditorView.lineWrapping,
      cmPlaceholder(messages.workspace.scriptPlaceholder),
      Prec.high(keymap.of([indentWithTab])),
    ],
    [messages.workspace.scriptPlaceholder],
  );

  return (
    <>
      <AppDialog
        open={open}
        title={editing ? messages.workspace.editScriptChipTitle : messages.workspace.placeScriptTitle}
        icon={<Braces className="size-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />}
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
            <Button type="button" className="gap-2" disabled={busy || !canConfigure} onClick={openNaming}>
              <BookmarkPlus className="size-3.5" aria-hidden="true" />
              {editing ? messages.query.applyChip : messages.query.registerTask}
            </Button>
          </>
        }
      >
        <div className="flex min-h-0 flex-1 flex-col p-4">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface">
            <PaneHeader title="main.js" description={messages.workspace.scriptHint} />
            <div className="relative min-h-0 flex-1">
              <CodeMirror
                className="h-full text-[13px]"
                height="100%"
                value={source}
                theme={theme === "dark" ? "dark" : "light"}
                extensions={extensions}
                editable={!busy}
                onChange={setSource}
              />
            </div>
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
            {editing ? messages.workspace.editScriptHint : messages.workspace.registerScriptHint}
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
        </div>
      </AppDialog>
    </>
  );
}
