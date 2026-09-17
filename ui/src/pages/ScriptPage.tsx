import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { indentWithTab } from "@codemirror/commands";
import { Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { BookmarkPlus, FileCode2, FileSpreadsheet, Plus, Trash2 } from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { SplitLayout } from "@/layouts/SplitLayout";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { PaneHeader } from "@/components/ui/pane-header";
import { useTheme } from "@/hooks/theme/useTheme";
import { useLanguage } from "@/i18n/LanguageProvider";
import { useWorkspacePick } from "@/hooks/workspace/useWorkspacePick";
import { WorkspacePickDialog } from "@/components/workspace/WorkspacePickDialog";
import { cn } from "@/lib/cn";
import { nextSequencedChipName } from "@/lib/chipSequence";
import { selectableClass } from "@/lib/selectable";
import { chipApi } from "@/services/chips/chipApi";
import { datasetApi } from "@/services/transform/datasetApi";
import { isChipNameConflict } from "@/services/httpClient";
import { toastError, toastSuccess } from "@/lib/notifications";
import { datasetFromSlot } from "@/features/transform/transformEditorModel";
import type { Chip } from "@/types/chip";
import type { Dataset } from "@/types/dataset";

export const DEFAULT_SCRIPT_MAIN = "function main(ctx) {\n  ctx.write(ctx.input() ?? []);\n}\n";

function validFileName(name: string) {
  return /^[A-Za-z0-9._-]+\.js$/.test(name) && !name.startsWith(".");
}

function filesFromChip(chip: Chip | null): Record<string, string> {
  const config = chip?.config ?? {};
  const files: Record<string, string> = {};
  if (config.files && typeof config.files === "object" && !Array.isArray(config.files)) {
    for (const [name, source] of Object.entries(config.files as Record<string, unknown>)) {
      if (typeof source === "string") files[name] = source;
    }
  }
  if (!files["main.js"]) files["main.js"] = DEFAULT_SCRIPT_MAIN;
  return files;
}

export function ScriptPage() {
  const { messages } = useLanguage();
  const { theme } = useTheme();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { workspaceId: routeWorkspaceId, editorChipId } = useParams<{
    workspaceId: string;
    editorChipId: string;
  }>();
  const workspaceId = routeWorkspaceId ?? searchParams.get("workspace") ?? undefined;
  const canvasMode = Boolean(workspaceId && editorChipId);
  const workspacePick = useWorkspacePick();

  const [chip, setChip] = useState<Chip | null>(null);
  const [chips, setChips] = useState<Chip[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [inputDatasetId, setInputDatasetId] = useState("");
  const [files, setFiles] = useState<Record<string, string>>({ "main.js": DEFAULT_SCRIPT_MAIN });
  const [activeFile, setActiveFile] = useState("main.js");
  const [newFile, setNewFile] = useState("");
  const [name, setName] = useState("");
  const [naming, setNaming] = useState(false);
  const [busy, setBusy] = useState(false);

  const editing = Boolean(chip);
  const names = Object.keys(files).sort((left, right) => left.localeCompare(right));
  const source = files[activeFile] ?? "";
  const occupiedNames = chips.map((item) => item.name);
  const nameTaken = occupiedNames.some(
    (value) => value.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase() && value !== chip?.name,
  );
  const canSave = Boolean(source.trim() && name.trim() && !nameTaken && inputDatasetId);

  useEffect(() => {
    void Promise.all([datasetApi.list(), chipApi.listCatalog()])
      .then(([datasetResponse, catalog]) => {
        setDatasets(datasetResponse.datasets);
        setChips(catalog.chips);
        if (!editorChipId) {
          setName(nextSequencedChipName(catalog.chips, messages.workspace.defaultScriptChipName, (item) => item.kind === "script"));
        }
      })
      .catch((error) => toastError(messages.workspace.saveChipError, error));
  }, [editorChipId, messages]);

  useEffect(() => {
    if (!editorChipId) return;
    void chipApi.get(editorChipId)
      .then((row) => {
        setChip(row);
        setName(row.name);
        const nextFiles = filesFromChip(row);
        setFiles(nextFiles);
        setActiveFile("main.js");
        const savedInput = typeof row.config.input_dataset_id === "string" ? row.config.input_dataset_id : "";
        if (!canvasMode) setInputDatasetId(savedInput);
      })
      .catch((error) => toastError(messages.workspace.saveChipError, error));
  }, [canvasMode, editorChipId, messages.workspace.saveChipError]);

  useEffect(() => {
    if (!workspaceId || !editorChipId) return;
    void chipApi.getInputSlot(workspaceId, editorChipId)
      .then((slot) => {
        const dataset = datasetFromSlot(slot);
        if (!dataset) return;
        setDatasets((current) => current.some((item) => item.id === dataset.id) ? current : [dataset, ...current]);
        setInputDatasetId(dataset.id);
      })
      .catch((error) => toastError(messages.workspace.saveChipError, error));
  }, [editorChipId, messages.workspace.saveChipError, workspaceId]);

  const draftDataset = searchParams.get("dataset")?.trim();
  useEffect(() => {
    if (canvasMode || !draftDataset || inputDatasetId) return;
    setInputDatasetId(draftDataset);
  }, [canvasMode, draftDataset, inputDatasetId]);

  const visibleDatasets = useMemo(
    () => (canvasMode ? datasets.filter((item) => item.id === inputDatasetId) : datasets),
    [canvasMode, datasets, inputDatasetId],
  );

  function setSource(next: string) {
    setFiles((current) => ({ ...current, [activeFile]: next }));
  }

  function addFile() {
    const file = newFile.trim();
    if (!validFileName(file) || files[file]) return;
    setFiles((current) => ({ ...current, [file]: "" }));
    setActiveFile(file);
    setNewFile("");
  }

  function removeFile(file: string) {
    if (file === "main.js") return;
    setFiles((current) => {
      const next = { ...current };
      delete next[file];
      return next;
    });
    if (activeFile === file) setActiveFile("main.js");
  }

  function configPayload() {
    return {
      entry: "main.js",
      files,
      input_dataset_id: inputDatasetId || undefined,
    };
  }

  async function saveToWorkspace(targetWorkspaceId: string) {
    const saved = editing && chip
      ? await chipApi.update(chip.id, { name: name.trim(), config: configPayload() })
      : await chipApi.create(targetWorkspaceId, { name: name.trim(), kind: "script", config: configPayload() });
    toastSuccess(messages.workspace.scriptChipSaved);
    setNaming(false);
    if (workspaceId || searchParams.get("new_chip") === "1") {
      navigate(`/workspace/${targetWorkspaceId}`);
      return;
    }
    navigate(`/workspace/${targetWorkspaceId}/chips/${saved.id}/script`, { replace: true });
  }

  async function save() {
    if (!canSave || busy) return;
    setBusy(true);
    try {
      const target = workspaceId || await workspacePick.pick();
      if (!target) return;
      await saveToWorkspace(target);
    } catch (error) {
      toastError(
        isChipNameConflict(error) ? messages.workspace.duplicateChipName : messages.workspace.saveChipError,
        isChipNameConflict(error) ? undefined : error,
      );
    } finally {
      setBusy(false);
    }
  }

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
    <PageShell>
      <PageHeader
        iconName="api"
        eyebrow={messages.nav.script}
        title={editing ? messages.workspace.editScriptChipTitle : messages.workspace.placeScriptTitle}
        description={messages.workspace.scriptHint}
        actions={
          <Button type="button" className="gap-2" disabled={busy || !inputDatasetId || !source.trim()} onClick={() => {
            setName((current) => current.trim() || chip?.name || messages.workspace.defaultScriptChipName(1));
            setNaming(true);
          }}>
            <BookmarkPlus className="size-3.5" aria-hidden="true" />
            {editing ? messages.query.applyChip : messages.query.registerTask}
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-surface">
        <SplitLayout className="h-full" defaultSizes={[280]} insetGutter>
          <aside className="flex h-full min-h-0 flex-col overflow-hidden">
            <SplitLayout direction="vertical" className="h-full" defaultSizes={[220]} minSize={140} insetGutter>
              <div className="flex h-full min-h-0 flex-col overflow-hidden">
                <PaneHeader title={messages.workspace.inputDataset} />
                <div className="scroll-pane min-h-0 flex-1 overflow-y-auto">
                  {visibleDatasets.length === 0 ? (
                    <p className="p-3 text-xs text-text-tertiary">{messages.workspace.selectDataset}</p>
                  ) : visibleDatasets.map((dataset) => (
                    <button
                      key={dataset.id}
                      type="button"
                      disabled={canvasMode || busy}
                      className={cn(
                        "flex w-full items-start gap-2 border-b border-border px-3 py-2.5 text-left last:border-b-0",
                        selectableClass(inputDatasetId === dataset.id),
                      )}
                      onClick={() => setInputDatasetId(dataset.id)}
                    >
                      <FileSpreadsheet className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium">{dataset.filename}</span>
                        <span className="mt-0.5 block truncate text-[11px] text-text-tertiary">
                          {dataset.kind}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex h-full min-h-0 flex-col overflow-hidden">
                <PaneHeader title={messages.workspace.scriptFiles} meta={messages.common.count(names.length)} />
                <div className="scroll-pane min-h-0 flex-1 overflow-y-auto">
                  {names.map((file) => (
                    <div
                      key={file}
                      className={cn(
                        "flex items-center gap-1 border-b border-border last:border-b-0",
                        selectableClass(file === activeFile),
                      )}
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate px-3 py-2 text-left text-[13px]"
                        onClick={() => setActiveFile(file)}
                      >
                        <FileCode2 className="mr-1.5 inline size-3.5 text-text-tertiary" aria-hidden="true" />
                        {file}
                        {file === "main.js" ? (
                          <span className="ml-1 text-[10px] text-text-tertiary">{messages.workspace.scriptEntry}</span>
                        ) : null}
                      </button>
                      {file === "main.js" ? null : (
                        <button
                          type="button"
                          className="grid size-8 place-items-center text-text-tertiary hover:text-danger"
                          aria-label={messages.common.delete}
                          onClick={() => removeFile(file)}
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex gap-1 border-t border-border p-2">
                  <input
                    className="field-control min-w-0 flex-1 text-xs"
                    value={newFile}
                    placeholder={messages.workspace.scriptAddFile}
                    disabled={busy}
                    onChange={(event) => setNewFile(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      addFile();
                    }}
                  />
                  <Button type="button" variant="secondary" className="h-8 gap-1 px-2" disabled={busy} onClick={addFile}>
                    <Plus className="size-3.5" aria-hidden="true" />
                    {messages.common.add}
                  </Button>
                </div>
              </div>
            </SplitLayout>
          </aside>
          <section className="flex h-full min-h-0 flex-col overflow-hidden">
            <PaneHeader title={activeFile} description={messages.workspace.scriptHint} />
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
          </section>
        </SplitLayout>
      </div>

      <AppDialog
        open={naming}
        title={editing ? messages.query.applyChip : messages.query.registerTaskTitle}
        icon={<BookmarkPlus className="size-4 text-accent" aria-hidden="true" />}
        className="w-[min(22rem,92vw)]"
        minWidth={320}
        minHeight={240}
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
      <WorkspacePickDialog {...workspacePick.dialogProps} />
    </PageShell>
  );
}
