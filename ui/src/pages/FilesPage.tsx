import { FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/Button";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { FileDropzone } from "@/components/FileDropzone";
import { NoticeBanner } from "@/components/NoticeBanner";
import { PageHeader, PageShell } from "@/components/PageShell";
import { Panel, PanelBody, PanelHeader } from "@/components/Panel";
import { Toolbar, ToolbarGroup } from "@/components/Toolbar";
import { api } from "@/lib/api";
import { fmtBytes } from "@/lib/format";
import { emptyCopy } from "@/mock/emptyStates";
import type { FileItem } from "@/types/pipeline";

export function FilesPage() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");

  async function refresh() {
    const response = await api.files();
    setFiles(response.files);
  }

  useEffect(() => {
    void refresh().catch((err) =>
      setError(err instanceof Error ? err.message : "파일 목록을 불러오지 못했습니다"),
    );
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("file") as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    setBusy(true);
    setError("");
    try {
      await api.upload(file);
      input.value = "";
      setName("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "파일 업로드에 실패했습니다");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell>
      <PageHeader
        eyebrow="작업 공간"
        title="파일"
        description="서버에 저장된 입력 파일입니다. 작업 소스로 선택할 수 있습니다."
      />
      {error ? <NoticeBanner>{error}</NoticeBanner> : null}

      <Panel>
        <PanelHeader title="파일 업로드" description="CSV 파일을 서버 작업 공간에 추가합니다." />
        <PanelBody>
          <form className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3" onSubmit={(event) => void onSubmit(event)}>
            <FileDropzone
              name="file"
              chosen={name}
              onChange={(event) => setName(event.target.files?.[0]?.name ?? "")}
            />
            <Button variant="primary" type="submit" disabled={busy || !name}>
              {busy ? "업로드 중…" : "업로드"}
            </Button>
          </form>
        </PanelBody>
      </Panel>

      <Panel className="min-h-0 flex-1">
        <Toolbar>
          <ToolbarGroup>
            <span className="text-[13px] font-semibold">저장된 파일</span>
            <span className="text-xs text-text-tertiary">{files.length}개</span>
          </ToolbarGroup>
        </Toolbar>
        <DataGrid headers={["파일명", "크기", "파일 ID", "저장 경로"]}>
          {files.length === 0 ? (
            <EmptyGridRow cols={4} text={emptyCopy.uploads} />
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
