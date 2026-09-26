import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { indentWithTab } from "@codemirror/commands";
import { Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { ArrowLeft, BookmarkPlus, ChevronRight, Download, FileCode2, FileSpreadsheet, Plus, Save, Search, Trash2 } from "lucide-react";
import { AppDialog } from "@/components/AppDialog";
import { EmptyState } from "@/components/DataGrid";
import { PreviewGrid } from "@/components/transform/TransformEditorParts";
import { PageHeader, PageShell } from "@/layouts/PageShell";
import { SplitLayout } from "@/layouts/SplitLayout";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { MetaField } from "@/components/ui/meta-field";
import { PaneHeader } from "@/components/ui/pane-header";
import { Panel } from "@/components/ui/panel";
import { useTheme } from "@/hooks/theme/useTheme";
import { useLanguage } from "@/i18n/LanguageProvider";
import { useWorkspacePick } from "@/hooks/workspace/useWorkspacePick";
import { WorkspacePickDialog } from "@/components/workspace/WorkspacePickDialog";
import { cn } from "@/lib/cn";
import { layout } from "@/lib/layout";
import { nextSequencedChipName } from "@/lib/chipSequence";
import { selectableClass } from "@/lib/selectable";
import { chipApi } from "@/services/chips/chipApi";
import { datasetApi } from "@/services/transform/datasetApi";
import { workspaceApi } from "@/services/workspace/workspaceApi";
import { isChipNameConflict, isWorkspaceVersionConflict } from "@/services/httpClient";
import { showConfirm, toastError, toastSuccess } from "@/lib/notifications";
import { fmtBytes } from "@/lib/format";
import {
  datasetFromSlot,
  emptyKindSearch,
  KIND_APPEARANCE,
  KIND_ORDER,
} from "@/features/transform/transformEditorModel";
import { storedDatasetId } from "@/features/workspace/workspaceCanvasModel";
import {
  DEFAULT_SCRIPT_HELPER,
  DEFAULT_SCRIPT_MAIN,
  MAX_SCRIPT_BYTES,
  MAX_SCRIPT_FILES,
  MAX_SCRIPT_INPUTS,
  SCRIPT_ENTRY,
  defaultScriptName,
  filesFromChip,
  inputsFromChip,
  outputFilenameFromChip,
  scriptBytes,
  uniqueInputName,
  validScriptFileName,
  type ScriptInputRef,
} from "@/features/script/scriptEditorModel";
import type { Chip } from "@/types/chip";
import type { Dataset, FramePreview } from "@/types/dataset";

function refsFromDatasetIds(ids: string[]): ScriptInputRef[] {
  const used = new Set<string>();
  return ids.slice(0, MAX_SCRIPT_INPUTS).map((dataset_id) => {
    const name = uniqueInputName("input", used);
    used.add(name);
    return { name, dataset_id };
  });
}

export function ScriptPage() {
  const { messages } = useLanguage();
  const { theme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { workspaceId: routeWorkspaceId, editorChipId } = useParams<{
    workspaceId: string;
    editorChipId: string;
  }>();
  const workspaceId = routeWorkspaceId ?? searchParams.get("workspace") ?? undefined;
  const canvasMode = Boolean(workspaceId && editorChipId);
  const newWorkspaceChip = Boolean(workspaceId && !editorChipId && searchParams.get("new_chip") === "1");
  const workspacePick = useWorkspacePick();
  const navigationState = location.state as { canvasDraft?: unknown } | null;

  const [chip, setChip] = useState<Chip | null>(null);
  const [chips, setChips] = useState<Chip[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [inputs, setInputs] = useState<ScriptInputRef[]>([]);
  const [lockedIds, setLockedIds] = useState<string[]>([]);
  const lockedIdsRef = useRef<string[]>([]);
  lockedIdsRef.current = lockedIds;
  const [files, setFiles] = useState<Record<string, string>>({ [SCRIPT_ENTRY]: DEFAULT_SCRIPT_MAIN });
  const [activeFile, setActiveFile] = useState(SCRIPT_ENTRY);
  const [newFile, setNewFile] = useState("");
  const [name, setName] = useState("");
  const [outputName, setOutputName] = useState("");
  const [addingFile, setAddingFile] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<FramePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expandedKinds, setExpandedKinds] = useState<Set<(typeof KIND_ORDER)[number]>>(new Set());
  const [kindSearch, setKindSearch] = useState(emptyKindSearch);

  const editing = Boolean(chip);
  const names = Object.keys(files).sort((left, right) => {
    if (left === SCRIPT_ENTRY) return -1;
    if (right === SCRIPT_ENTRY) return 1;
    return left.localeCompare(right);
  });
  const source = files[activeFile] ?? "";
  const entrySource = files[SCRIPT_ENTRY] ?? "";
  const occupiedNames = chips.map((item) => item.name);
  const nameTaken = occupiedNames.some(
    (value) => value.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase() && value !== chip?.name,
  );
  const canSave = Boolean(entrySource.trim() && name.trim() && !nameTaken && (canvasMode || inputs.length));
  const canOpenSave = Boolean(entrySource.trim() && (canvasMode || inputs.length));
  const selected = datasets.find((item) => item.id === inputs[0]?.dataset_id);
  const schemaOnly = (dataset?: Dataset) =>
    dataset?.status === "connected"
    || dataset?.status === "planned"
    || dataset?.available === false
    || !storedDatasetId(dataset?.id);
  const materializedInputs = inputs.filter((item) => {
    const dataset = datasets.find((row) => row.id === item.dataset_id);
    return storedDatasetId(item.dataset_id) && !schemaOnly(dataset);
  });
  const pendingFirstResult = previewOpen && materializedInputs.length === 0;
  const canExportResult = !editorChipId && !newWorkspaceChip && materializedInputs.length > 0;
  const selectedLabel = inputs.length === 0 ? "—" : inputs.map((item) => item.name).join(", ");

  useEffect(() => {
    void Promise.all([datasetApi.list(), chipApi.listCatalog()])
      .then(([datasetResponse, catalog]) => {
        setDatasets(datasetResponse.datasets);
        setChips(catalog.chips);
        if (!editorChipId) {
          setName(
            searchParams.get("chip_name")?.trim()
            || nextSequencedChipName(catalog.chips, messages.workspace.defaultScriptChipName, (item) => item.kind === "script"),
          );
        }
      })
      .catch((error) => toastError(messages.workspace.saveChipError, error));
  }, [editorChipId, messages, searchParams]);

  const draftDatasets = [...new Set(
    searchParams.getAll("dataset").map((id) => id.trim()).filter(Boolean),
  )];

  useEffect(() => {
    if (!editorChipId) {
      setChip(null);
      setFiles({ [SCRIPT_ENTRY]: DEFAULT_SCRIPT_MAIN });
      setActiveFile(SCRIPT_ENTRY);
      setLockedIds([]);
      setInputs(refsFromDatasetIds(draftDatasets));
      setNewFile("");
      setAddingFile(false);
      setPreview(null);
      setPreviewOpen(false);
      setRegisterOpen(false);
      setOutputName("");
      return;
    }
    let cancelled = false;
    setChip(null);
    setFiles({ [SCRIPT_ENTRY]: DEFAULT_SCRIPT_MAIN });
    setActiveFile(SCRIPT_ENTRY);
    void chipApi.get(editorChipId)
      .then((row) => {
        if (cancelled) return;
        setChip(row);
        setName(row.name);
        const nextFiles = filesFromChip(row);
        setFiles(nextFiles);
        setActiveFile(SCRIPT_ENTRY in nextFiles ? SCRIPT_ENTRY : Object.keys(nextFiles)[0] ?? SCRIPT_ENTRY);
        setOutputName(outputFilenameFromChip(row) || row.name);
        setInputs((current) => {
          const saved = inputsFromChip(row);
          if (!canvasMode) return saved;
          const locked = current.filter((item) => lockedIdsRef.current.includes(item.dataset_id));
          const extras = saved.filter((item) => !locked.some((lock) => lock.dataset_id === item.dataset_id));
          return [...locked, ...extras].slice(0, MAX_SCRIPT_INPUTS);
        });
      })
      .catch((error) => {
        if (!cancelled) toastError(messages.workspace.saveChipError, error);
      });
    return () => {
      cancelled = true;
    };
  }, [canvasMode, editorChipId, messages.workspace.saveChipError]);

  useEffect(() => {
    if (!workspaceId || !editorChipId) return;
    void chipApi.getInputSlot(workspaceId, editorChipId)
      .then((slot) => {
        const slots = slot.slots?.length ? slot.slots : [slot];
        const locked: ScriptInputRef[] = [];
        const extraDatasets: Dataset[] = [];
        const used = new Set<string>();
        for (const item of slots) {
          const dataset = datasetFromSlot(item);
          if (!dataset) continue;
          extraDatasets.push(dataset);
          const name = uniqueInputName(item.source_chip_name || dataset.filename, used);
          used.add(name);
          locked.push({ name, dataset_id: dataset.id });
        }
        if (locked.length === 0) {
          setLockedIds([]);
          return;
        }
        setLockedIds(locked.map((item) => item.dataset_id));
        setDatasets((current) => {
          const next = [...current];
          for (const dataset of extraDatasets) {
            if (!next.some((item) => item.id === dataset.id)) next.unshift(dataset);
          }
          return next;
        });
        setInputs((current) => {
          const extras = current.filter((item) => !locked.some((lock) => lock.dataset_id === item.dataset_id));
          return [...locked, ...extras].slice(0, MAX_SCRIPT_INPUTS);
        });
      })
      .catch((error) => toastError(messages.workspace.saveChipError, error));
  }, [editorChipId, messages.workspace.saveChipError, workspaceId]);

  useEffect(() => {
    if (canvasMode || draftDatasets.length === 0 || inputs.length) return;
    setInputs(refsFromDatasetIds(draftDatasets));
  }, [canvasMode, draftDatasets.join("|"), inputs.length]);

  useEffect(() => {
    if (editorChipId) return;
    setOutputName(selected?.filename ? defaultScriptName(selected.filename) : "");
  }, [editorChipId, selected?.id, selected?.filename]);

  useEffect(() => {
    if (inputs.length === 0) return;
    for (const item of inputs) {
      if (lockedIds.includes(item.dataset_id)) continue;
      const row = datasets.find((dataset) => dataset.id === item.dataset_id);
      if (!row || !KIND_ORDER.includes(row.kind as (typeof KIND_ORDER)[number])) continue;
      const kind = row.kind as (typeof KIND_ORDER)[number];
      setExpandedKinds((current) => {
        if (current.has(kind)) return current;
        const next = new Set(current);
        next.add(kind);
        return next;
      });
    }
  }, [datasets, inputs, lockedIds]);

  const kindLabel: Record<string, string> = {
    upload: messages.transform.kindUpload,
    database: messages.transform.kindDatabase,
    api: messages.transform.kindApi,
    transform: messages.transform.kindTransform,
    script: messages.transform.kindScript,
  };
  const grouped = useMemo(
    () => KIND_ORDER.map((kind) => ({
      kind,
      items: datasets.filter((item) => item.kind === kind && !lockedIds.includes(item.id)),
    })),
    [datasets, lockedIds],
  );
  const lockedDatasets = useMemo(
    () => lockedIds
      .map((id) => datasets.find((item) => item.id === id))
      .filter((item): item is Dataset => Boolean(item)),
    [datasets, lockedIds],
  );
  const catalogCount = datasets.filter((item) => !lockedIds.includes(item.id)).length;

  function toggleInput(dataset: Dataset) {
    if (lockedIds.includes(dataset.id)) return;
    setInputs((current) => {
      if (current.some((item) => item.dataset_id === dataset.id)) {
        return current.filter((item) => item.dataset_id !== dataset.id);
      }
      if (current.length >= MAX_SCRIPT_INPUTS) {
        toastError(messages.workspace.scriptTooManyInputs);
        return current;
      }
      return [...current, {
        name: uniqueInputName(dataset.filename, current.map((item) => item.name)),
        dataset_id: dataset.id,
      }];
    });
  }

  function setSource(next: string) {
    setFiles((current) => ({ ...current, [activeFile]: next }));
  }

  function addFile() {
    const file = newFile.trim();
    if (!validScriptFileName(file)) {
      toastError(messages.workspace.scriptInvalidFileName);
      return false;
    }
    if (files[file]) {
      toastError(messages.workspace.scriptFileExists);
      return false;
    }
    if (Object.keys(files).length >= MAX_SCRIPT_FILES) {
      toastError(messages.workspace.scriptTooManyFiles);
      return false;
    }
    setFiles((current) => ({ ...current, [file]: DEFAULT_SCRIPT_HELPER }));
    setActiveFile(file);
    setNewFile("");
    setAddingFile(false);
    return true;
  }

  async function removeFile(file: string) {
    if (file === SCRIPT_ENTRY) return;
    const confirmed = await showConfirm(
      messages.script.deleteFileTitle,
      messages.script.deleteFileMessage(file),
      { tone: "danger", confirmLabel: messages.common.delete },
    );
    if (!confirmed) return;
    setFiles((current) => {
      const next = { ...current };
      delete next[file];
      return next;
    });
    if (activeFile === file) setActiveFile(SCRIPT_ENTRY);
  }

  function configPayload() {
    return {
      entry: SCRIPT_ENTRY,
      files,
      input_dataset_id: storedDatasetId(inputs[0]?.dataset_id) || undefined,
      inputs: inputs
        .map((item) => ({ name: item.name, dataset_id: storedDatasetId(item.dataset_id) }))
        .filter((item) => item.dataset_id),
      output_filename: outputName.trim() || (selected?.filename ? defaultScriptName(selected.filename) : undefined),
    };
  }

  function leaveEditor() {
    if (workspaceId) {
      navigate(`/workspace/${workspaceId}`, {
        state: navigationState?.canvasDraft
          ? { canvasDraft: navigationState.canvasDraft }
          : undefined,
      });
      return;
    }
    navigate("/chips");
  }

  async function placeOnWorkspace(targetWorkspaceId: string, chipId: string) {
    const [workspace, chipResponse] = await Promise.all([
      workspaceApi.get(targetWorkspaceId),
      chipApi.list(targetWorkspaceId),
    ]);
    const x = Number(searchParams.get("x"));
    const y = Number(searchParams.get("y"));
    const ids = chipResponse.chips.map((item) => item.id);
    if (!ids.includes(chipId)) ids.push(chipId);
    await workspaceApi.save(targetWorkspaceId, {
      version: workspace.version,
      layout: {
        ...workspace.layout,
        nodes: {
          ...(workspace.layout.nodes ?? {}),
          [chipId]: {
            x: Number.isFinite(x) ? x : 80,
            y: Number.isFinite(y) ? y : 80,
          },
        },
      },
      chips: ids,
      edges: (workspace.edges ?? []).map((edge) => ({
        id: edge.id,
        from_chip_id: edge.from_chip_id,
        to_chip_id: edge.to_chip_id,
        kind: edge.kind,
        from_port: edge.from_port,
        to_port: edge.to_port,
      })),
    });
  }

  async function persistChip(targetWorkspaceId: string) {
    if (scriptBytes(files) > MAX_SCRIPT_BYTES) {
      toastError(messages.workspace.scriptTooLarge);
      return;
    }
    const title = name.trim() || chip?.name || messages.workspace.defaultScriptChipName(1);
    const saved = editing && chip
      ? await chipApi.update(chip.id, { name: title, config: configPayload() })
      : await chipApi.create(targetWorkspaceId, { name: title, kind: "script", config: configPayload() });
    if (newWorkspaceChip) {
      try {
        await placeOnWorkspace(targetWorkspaceId, saved.id);
      } catch (error) {
        await chipApi.remove(saved.id).catch(() => undefined);
        throw error;
      }
    }
    setChip(saved);
    setName(saved.name);
    const savedOutput = outputFilenameFromChip(saved);
    if (savedOutput) setOutputName(savedOutput);
    return saved;
  }

  async function saveToWorkspace(targetWorkspaceId: string) {
    const saved = await persistChip(targetWorkspaceId);
    if (!saved) return;
    toastSuccess(messages.workspace.scriptChipSaved);
    setRegisterOpen(false);
    setPreviewOpen(false);
    if (newWorkspaceChip) {
      navigate(`/workspace/${targetWorkspaceId}/chips/${saved.id}`);
      return;
    }
    if (workspaceId) {
      leaveEditor();
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
        isChipNameConflict(error)
          ? messages.workspace.duplicateChipName
          : isWorkspaceVersionConflict(error)
            ? messages.workspace.versionConflict
            : messages.workspace.saveChipError,
        isChipNameConflict(error) || isWorkspaceVersionConflict(error) ? undefined : error,
      );
    } finally {
      setBusy(false);
    }
  }

  function openRegister() {
    if (busy || !canOpenSave) return;
    setName((current) => current.trim() || chip?.name || messages.workspace.defaultScriptChipName(1));
    setOutputName((current) => current.trim() || (selected?.filename ? defaultScriptName(selected.filename) : current));
    setRegisterOpen(true);
  }

  async function exportResult() {
    if (!canExportResult) return;
    const dest = await workspacePick.pick(selected?.workspace_id);
    if (!dest) return;
    setBusy(true);
    try {
      const saved = await persistChip(dest);
      if (!saved) return;
      const queued = await chipApi.run(saved.id, {
        workspace_id: dest,
        input_dataset_id: storedDatasetId(inputs[0]?.dataset_id) || undefined,
      });
      let run = await chipApi.getRun(queued.id);
      while (run.status === "queued" || run.status === "running") {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        run = await chipApi.getRun(run.id);
      }
      if (run.status !== "succeeded") {
        toastError(messages.errors.runJob, run.error_message);
        return;
      }
      if (!run.output_dataset_id) {
        toastError(messages.errors.runJob);
        return;
      }
      const link = document.createElement("a");
      link.href = datasetApi.getDownloadUrl(run.output_dataset_id);
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      toastSuccess(messages.script.exportComplete, messages.script.exportDone(run.output_rows ?? preview?.row_count ?? 0));
    } catch (error) {
      toastError(
        isChipNameConflict(error)
          ? messages.workspace.duplicateChipName
          : isWorkspaceVersionConflict(error)
            ? messages.workspace.versionConflict
            : messages.errors.runJob,
        isChipNameConflict(error) || isWorkspaceVersionConflict(error) ? undefined : error,
      );
    } finally {
      setBusy(false);
    }
  }

  async function openResultDialog() {
    if (busy || !canOpenSave) return;
    setPreviewOpen(true);
    setPreview(null);
    if (materializedInputs.length === 0) return;
    setPreviewLoading(true);
    try {
      const previewId = materializedInputs[0].dataset_id;
      setPreview(await datasetApi.previewScript(previewId, files, SCRIPT_ENTRY, 200, materializedInputs));
    } catch (error) {
      toastError(messages.errors.previewScript, error);
    } finally {
      setPreviewLoading(false);
    }
  }

  const registerOpenRef = useRef(registerOpen);
  const previewOpenRef = useRef(previewOpen);
  const openRegisterRef = useRef(openRegister);
  const openResultDialogRef = useRef(openResultDialog);
  const saveRef = useRef(save);
  registerOpenRef.current = registerOpen;
  previewOpenRef.current = previewOpen;
  openRegisterRef.current = openRegister;
  openResultDialogRef.current = openResultDialog;
  saveRef.current = save;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (registerOpenRef.current) {
        void saveRef.current();
        return;
      }
      if (previewOpenRef.current) {
        openRegisterRef.current();
        return;
      }
      void openResultDialogRef.current();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

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
        iconName="script"
        eyebrow={messages.nav.script}
        title={messages.script.title}
        description={messages.script.description}
        actions={
          <>
            {workspaceId ? (
              <>
                <Button type="button" variant="quiet" className="gap-2" disabled={busy} onClick={leaveEditor}>
                  <ArrowLeft className="size-3.5" aria-hidden="true" />
                  {messages.transform.returnToWorkspace}
                </Button>
                <span className="w-3" aria-hidden="true" />
              </>
            ) : null}
            <Button type="button" className="gap-2" disabled={busy || !canOpenSave} onClick={() => void openResultDialog()}>
              <Save className="size-3.5" aria-hidden="true" />
              {messages.common.save}
            </Button>
          </>
        }
      />
      <Panel tall className="overflow-hidden">
        <SplitLayout className="min-h-0 flex-1" defaultSizes={[layout.split.catalog]}>
          <aside className="flex min-h-0 flex-col overflow-hidden">
            <PaneHeader
              title={messages.transform.catalog}
              meta={messages.common.count(catalogCount)}
            />
            <div className="scroll-pane min-h-0 flex-1 overflow-auto bg-surface">
              {canvasMode && lockedIds.length > 0 ? (
                <div className="border-b border-border">
                  <p className="px-3 py-2 text-[11px] text-text-tertiary">{messages.workspace.inputFromEdge}</p>
                  {lockedDatasets.map((dataset) => {
                    const key = inputs.find((item) => item.dataset_id === dataset.id)?.name;
                    return (
                      <div
                        key={dataset.id}
                        className={cn(
                          "flex w-full items-start gap-2 border-b border-border px-3 py-2.5 text-left last:border-b-0",
                          selectableClass(true),
                        )}
                      >
                        <FileSpreadsheet className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
                        <span className="min-w-0">
                          <span className="block break-all text-[13px] font-medium leading-4">{dataset.filename}</span>
                          <span className="mt-0.5 block truncate text-[11px] text-text-tertiary">
                            {key ? messages.script.inputKey(key) : messages.workspace.inputFromEdge}
                          </span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              <div className="space-y-2 p-2">
                {grouped.map((group) => {
                    const appearance = KIND_APPEARANCE[group.kind];
                    const KindIcon = appearance.icon;
                    const expanded = expandedKinds.has(group.kind);
                    const query = kindSearch[group.kind].trim().toLocaleLowerCase();
                    const visibleItems = query
                      ? group.items.filter((item) => item.filename.toLocaleLowerCase().includes(query))
                      : group.items;
                    return (
                      <section key={group.kind} className="overflow-hidden rounded-lg border border-border bg-surface">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          className={cn(
                            "flex w-full items-center gap-2 px-3 py-2.5 text-left transition-[filter] hover:brightness-95",
                            expanded && "border-b",
                            appearance.header,
                          )}
                          onClick={() => setExpandedKinds((current) => {
                            const next = new Set(current);
                            if (expanded) next.delete(group.kind);
                            else next.add(group.kind);
                            return next;
                          })}
                        >
                          <KindIcon className="size-4 shrink-0" aria-hidden="true" />
                          <span className="min-w-0 flex-1 text-sm font-bold">{kindLabel[group.kind]}</span>
                          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums", appearance.count)}>
                            {group.items.length}
                          </span>
                          <ChevronRight className={cn("size-4 shrink-0 transition-transform", expanded && "rotate-90")} aria-hidden="true" />
                        </button>
                        {expanded ? (
                          <div className="border-b border-border bg-raised p-2.5">
                            <div className="group flex h-9 items-center overflow-hidden rounded-lg border border-border bg-surface shadow-sm focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
                              <span className="grid h-full w-9 shrink-0 place-items-center border-r border-border bg-subtle text-text-tertiary group-focus-within:text-accent">
                                <Search className="size-3.5" aria-hidden="true" />
                              </span>
                              <input
                                type="search"
                                className="min-w-0 flex-1 bg-transparent px-3 text-[13px] text-text outline-none placeholder:text-text-tertiary"
                                value={kindSearch[group.kind]}
                                placeholder={messages.transform.searchFiles}
                                aria-label={`${kindLabel[group.kind]} ${messages.transform.searchFiles}`}
                                onChange={(event) => setKindSearch((current) => ({ ...current, [group.kind]: event.target.value }))}
                              />
                            </div>
                          </div>
                        ) : null}
                        {expanded && visibleItems.length === 0 ? (
                          <p className="px-3 py-4 text-center text-xs text-text-tertiary">{messages.transform.noMatchingFiles}</p>
                        ) : null}
                        {expanded && visibleItems.map((dataset) => {
                          const selectedInput = inputs.find((item) => item.dataset_id === dataset.id);
                          const locked = lockedIds.includes(dataset.id);
                          return (
                          <button
                            key={dataset.id}
                            type="button"
                            disabled={busy || locked}
                            className={cn(
                              "flex w-full min-w-0 items-start gap-2 border-b border-border px-3 py-2.5 text-left last:border-b-0",
                              selectableClass(Boolean(selectedInput)),
                            )}
                            onClick={() => toggleInput(dataset)}
                          >
                            <FileSpreadsheet className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
                            <span className="min-w-0 flex-1">
                              <span className="block break-all text-[13px] font-medium leading-4">{dataset.filename}</span>
                              <span className="mt-0.5 block truncate text-[11px] text-text-tertiary">
                                {selectedInput
                                  ? messages.script.inputKey(selectedInput.name)
                                  : dataset.origin?.connection_name
                                    ? `${dataset.origin.connection_name} · ${dataset.origin.table_name}`
                                    : dataset.row_count != null
                                      ? messages.common.rows(dataset.row_count)
                                      : dataset.size_bytes != null
                                        ? fmtBytes(dataset.size_bytes)
                                        : dataset.id.slice(0, 8)}
                              </span>
                            </span>
                          </button>
                          );
                        })}
                      </section>
                    );
                  })}
              </div>
            </div>
          </aside>
          <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="grid items-stretch gap-4 border-b border-border px-4 py-3 md:grid-cols-2">
              <FormField label={messages.script.namePlaceholder}>
                <div className="flex h-[3.25rem] items-start gap-2 rounded border border-border bg-surface px-2.5 py-1.5 text-[13px] focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
                  <FileSpreadsheet className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
                  <textarea
                    rows={2}
                    className="h-[2.5rem] min-w-0 flex-1 resize-none overflow-x-auto overflow-y-auto bg-transparent leading-5 text-text outline-none placeholder:text-text-tertiary"
                    value={outputName}
                    placeholder={messages.script.namePlaceholder}
                    onChange={(event) => setOutputName(event.target.value)}
                  />
                </div>
              </FormField>
              <FormField label={messages.transform.selectedFile}>
                <div className="flex h-[3.25rem] items-start gap-2 rounded border border-border bg-raised px-2.5 py-1.5 text-[13px]">
                  <FileSpreadsheet className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
                  <span
                    title={selectedLabel}
                    className="line-clamp-2 h-[2.5rem] min-w-0 flex-1 overflow-hidden break-all leading-5"
                  >
                    {selectedLabel}
                  </span>
                </div>
              </FormField>
            </div>
            <SplitLayout className="min-h-0 flex-1" defaultSizes={[220]} minSize={140} insetGutter>
            <aside className="flex h-full min-h-0 flex-col overflow-hidden">
              <PaneHeader
                title={messages.workspace.scriptFiles}
                meta={messages.common.count(names.length)}
                actions={
                  <Button
                    type="button"
                    variant="quiet"
                    className="h-8 gap-1 px-2"
                    disabled={busy || names.length >= MAX_SCRIPT_FILES}
                    onClick={() => {
                      setNewFile("");
                      setAddingFile(true);
                    }}
                  >
                    <Plus className="size-3.5" aria-hidden="true" />
                    {messages.script.addFileTitle}
                  </Button>
                }
              />
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
                      {file === SCRIPT_ENTRY ? (
                        <span className="ml-1 text-[10px] text-text-tertiary">{messages.workspace.scriptEntry}</span>
                      ) : null}
                    </button>
                    {file === SCRIPT_ENTRY ? null : (
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
            </aside>
            <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
              <PaneHeader title={activeFile} description={messages.workspace.scriptEditorHint} />
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
          </section>
        </SplitLayout>
      </Panel>

      <AppDialog
        open={addingFile}
        title={messages.script.addFileTitle}
        icon={<FileCode2 className="size-4 text-accent" aria-hidden="true" />}
        className="w-[min(22rem,92vw)]"
        minWidth={320}
        minHeight={220}
        onClose={() => setAddingFile(false)}
        footer={
          <>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setAddingFile(false)}>
              {messages.common.cancel}
            </Button>
            <Button type="button" variant="primary" disabled={busy || names.length >= MAX_SCRIPT_FILES} onClick={addFile}>
              {messages.common.add}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 p-4">
          <p className="text-[11px] leading-5 text-text-tertiary">{messages.script.addFileHint}</p>
          <FormField label={messages.script.addFileName}>
            <input
              className="field-control"
              value={newFile}
              autoFocus
              disabled={busy}
              placeholder={messages.workspace.scriptAddFile}
              onChange={(event) => setNewFile(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                addFile();
              }}
            />
          </FormField>
        </div>
      </AppDialog>

      <AppDialog
        open={previewOpen}
        title={messages.script.resultDialogTitle}
        icon={<FileSpreadsheet className="size-4 text-accent" aria-hidden="true" />}
        className={
          pendingFirstResult
            ? "h-[min(22rem,70vh)] w-[min(34rem,94vw)]"
            : "h-[90vh] w-[96vw] max-w-[90rem]"
        }
        minWidth={pendingFirstResult ? 360 : 560}
        minHeight={pendingFirstResult ? 240 : 360}
        onClose={() => setPreviewOpen(false)}
        footer={
          <>
            {canExportResult ? (
              <Button
                type="button"
                variant="primary"
                className="gap-2"
                disabled={busy || previewLoading}
                onClick={() => void exportResult()}
              >
                <Download className="size-3.5" aria-hidden="true" />
                {busy ? messages.transform.exporting : messages.transform.resultFile}
              </Button>
            ) : null}
            <Button
              type="button"
              variant={canExportResult ? undefined : "primary"}
              className="gap-2"
              disabled={busy}
              onClick={openRegister}
            >
              <BookmarkPlus className="size-3.5" aria-hidden="true" />
              {editing ? messages.transform.applyToChip : messages.transform.register}
            </Button>
          </>
        }
      >
        {pendingFirstResult ? (
          <EmptyState title={messages.script.resultNeedsRunTitle} hint={messages.script.resultNeedsRunHint} />
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {canExportResult ? (
              <div className="border-b border-border px-4 py-3">
                <FormField label={messages.script.namePlaceholder}>
                  <input
                    className="field-control"
                    value={outputName}
                    disabled={busy}
                    placeholder={messages.script.namePlaceholder}
                    onChange={(event) => setOutputName(event.target.value)}
                  />
                </FormField>
              </div>
            ) : null}
            {preview ? (
              <div className="flex min-w-0 shrink-0 flex-wrap items-start gap-5 border-b border-border px-4 py-2.5">
                <MetaField label={messages.files.previewRows} technical>
                  {messages.common.rows(preview.sampled_rows)}
                </MetaField>
                {preview.row_count != null ? (
                  <MetaField label={messages.files.totalRows} technical>
                    {messages.common.rows(preview.row_count)}
                  </MetaField>
                ) : null}
                {preview.columns.length > 0 ? (
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-medium leading-none text-text-tertiary">
                      {messages.common.columns}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {preview.columns.map((column) => (
                        <span
                          key={column.name}
                          title={`${column.name} ${column.dtype}`}
                          className="max-w-full truncate rounded-full border border-border bg-raised px-2 py-0.5 text-[11px] font-medium text-text"
                        >
                          {column.name}
                          <span className="ml-1 text-text-tertiary">{column.dtype}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden p-4">
              {previewLoading ? (
                <div className="grid h-full min-h-64 place-items-center text-sm text-text-tertiary">
                  {messages.common.loading}
                </div>
              ) : (
                <PreviewGrid preview={preview} empty={messages.script.previewHint} />
              )}
            </div>
          </div>
        )}
      </AppDialog>

      <AppDialog
        open={registerOpen}
        title={editing ? messages.transform.applyToChip : messages.transform.register}
        icon={<BookmarkPlus className="size-4 text-accent" aria-hidden="true" />}
        className="w-[min(22rem,92vw)]"
        minWidth={320}
        minHeight={280}
        zIndex={120}
        onClose={() => setRegisterOpen(false)}
        footer={
          <>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setRegisterOpen(false)}>
              {messages.common.cancel}
            </Button>
            <Button type="button" variant="primary" disabled={busy || !canSave} onClick={() => void save()}>
              {busy ? messages.common.saving : messages.common.confirm}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 p-4">
          <p className="text-[11px] leading-5 text-text-tertiary">{messages.script.registerHint}</p>
          {editing ? null : (
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
          )}
          <FormField label={messages.script.namePlaceholder}>
            <input
              className="field-control"
              value={outputName}
              autoFocus={editing}
              disabled={busy}
              placeholder={messages.script.namePlaceholder}
              onChange={(event) => setOutputName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                void save();
              }}
            />
          </FormField>
          <dl className="space-y-2 border-t border-border/60 pt-3 text-[11px] text-text-tertiary">
            <div className="flex gap-2">
              <dt className="w-14 shrink-0">{messages.transform.selectedFile}</dt>
              <dd className="min-w-0 truncate text-text-secondary">{selectedLabel}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-14 shrink-0">{messages.workspace.scriptFiles}</dt>
              <dd className="text-text-secondary">{messages.script.registerSummaryFiles(names.length)}</dd>
            </div>
          </dl>
        </div>
      </AppDialog>
      <WorkspacePickDialog {...workspacePick.dialogProps} />
    </PageShell>
  );
}
