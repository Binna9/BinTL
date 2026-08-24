import { FormEvent, useState } from "react";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { FileDropzone } from "@/components/FileDropzone";
import { PageHeader, PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { NoticeBanner } from "@/components/ui/notice-banner";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { useFiles } from "@/hooks/useFiles";
import { useLanguage } from "@/i18n/LanguageProvider";
import { fmtBytes } from "@/lib/format";
import { fileApi } from "@/services/fileApi";

export function FilesPage() {
  const { messages } = useLanguage();
  const { files, filesError, setFilesError, refreshFiles } = useFiles();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("file") as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    setBusy(true);
    setFilesError("");
    try {
      await fileApi.uploadFile(file);
      input.value = "";
      setName("");
      await refreshFiles();
    } catch (err) {
      setFilesError(err instanceof Error ? err.message : messages.errors.upload);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell>
      <PageHeader
        iconName="files"
        eyebrow={messages.files.eyebrow}
        title={messages.files.title}
        description={messages.files.description}
      />
      {filesError ? <NoticeBanner>{filesError}</NoticeBanner> : null}

      <Panel>
        <PanelHeader title={messages.files.uploadTitle} description={messages.files.uploadDescription} />
        <PanelBody>
          <form className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3" onSubmit={(event) => void onSubmit(event)}>
            <FileDropzone
              name="file"
              chosen={name}
              onChange={(event) => setName(event.target.files?.[0]?.name ?? "")}
            />
            <Button variant="primary" type="submit" disabled={busy || !name}>
              {busy ? messages.files.uploading : messages.files.upload}
            </Button>
          </form>
        </PanelBody>
      </Panel>

      <Panel className="min-h-0 flex-1">
        <Toolbar>
          <ToolbarGroup>
            <span className="text-[13px] font-semibold">{messages.files.stored}</span>
            <span className="text-xs text-text-tertiary">{messages.common.count(files.length)}</span>
          </ToolbarGroup>
        </Toolbar>
        <DataGrid headers={[...messages.files.headers]}>
          {files.length === 0 ? (
            <EmptyGridRow cols={4} text={messages.empty.uploads} />
          ) : (
            files.map((file) => (
              <GridRow key={`${file.id}-${file.filename}`}>
                <GridCell>{file.filename}</GridCell>
                <GridCell mono>{fmtBytes(file.size)}</GridCell>
                <GridCell mono muted>{file.id.slice(0, 8)}</GridCell>
                <GridCell mono muted>{file.stored_path}</GridCell>
              </GridRow>
            ))
          )}
        </DataGrid>
      </Panel>
    </PageShell>
  );
}
