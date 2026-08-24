import { FormEvent, ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/Button";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { FormField } from "@/components/FormField";
import { NoticeBanner } from "@/components/NoticeBanner";
import { PageHeader, PageShell } from "@/components/PageShell";
import { Panel, PanelHeader } from "@/components/Panel";
import { SplitLayout } from "@/components/SplitLayout";
import { StatusPill } from "@/components/StatusPill";
import { Toolbar, ToolbarGroup } from "@/components/Toolbar";
import { api } from "@/lib/api";
import { fmtSqlPreview, fmtWhen } from "@/lib/format";
import { layout } from "@/lib/layout";
import { emptyCopy } from "@/mock/emptyStates";
import type { Connection, ExtractItem, FileItem, Job } from "@/types/pipeline";

function parseRename(raw: string): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const [from, to] = part.split(":").map((value) => value.trim());
    if (from && to) result[from] = to;
  }
  return Object.keys(result).length ? result : undefined;
}

function BuilderSection({
  index,
  title,
  description,
  children,
}: {
  index: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <SplitLayout
      fill={false}
      className="border-b border-border last:border-b-0"
      defaultSizes={[layout.split.builder]}
      minSize={layout.split.minBuilder}
    >
      <header className="h-full bg-raised p-4">
        <span className="technical text-text-tertiary">{index}</span>
        <h3 className="mt-2 text-sm font-semibold">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-text-secondary">{description}</p>
      </header>
      <div className="grid content-start gap-3 p-4 md:grid-cols-2">{children}</div>
    </SplitLayout>
  );
}

export function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [extracts, setExtracts] = useState<ExtractItem[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [sourceTables, setSourceTables] = useState<string[]>([]);
  const [destinationTables, setDestinationTables] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [jobResult, fileResult, extractResult, connectionResult] = await Promise.all([
      api.jobs(50),
      api.files(),
      api.extracts(50),
      api.connections(),
    ]);
    setJobs(jobResult.jobs);
    setFiles(fileResult.files);
    setExtracts(extractResult.extracts.filter((extract) => extract.status === "succeeded"));
    setConnections(connectionResult.connections);
  }

  useEffect(() => {
    void refresh().catch((err) =>
      setError(err instanceof Error ? err.message : "작업 정보를 불러오지 못했습니다"),
    );
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const value = (name: string) =>
      (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value;
    const selectedColumns = value("select")
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean);
    const destinationConnectionId = value("dest_connection_id");

    setError("");
    setBusy(true);
    try {
      const job = await api.createEtlJob({
        file_id: value("file_id") || undefined,
        extract_id: value("extract_id") || undefined,
        connection_id: value("connection_id") || undefined,
        table: value("table") || undefined,
        dest_connection_id: destinationConnectionId || undefined,
        dest_table: value("dest_table") || undefined,
        mode: destinationConnectionId ? value("mode") : undefined,
        select: selectedColumns.length ? selectedColumns : undefined,
        filter: value("filter") || undefined,
        rename: parseRename(value("rename")),
      });
      await api.runJob(job.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "작업 생성에 실패했습니다");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell>
      <PageHeader
        iconName="jobs"
        eyebrow="파이프라인"
        title="작업"
        description="파일 또는 테이블을 소스로 선택하고 변환한 뒤 parquet와 대상 테이블에 적재합니다."
      />
      {error ? <NoticeBanner>{error}</NoticeBanner> : null}

      <Panel>
        <PanelHeader title="작업 정의" description="소스, 변환, 적재 조건을 순서대로 지정합니다." />
        <form onSubmit={(event) => void onSubmit(event)}>
          <BuilderSection index="01" title="소스" description="업로드 파일, 추출 파일, 커넥션 테이블 중 하나를 선택합니다.">
            <FormField label="업로드 파일">
              <select className="field-control" name="file_id">
                <option value="">선택 안 함</option>
                {files.map((file) => (
                  <option key={file.id} value={file.id}>{file.filename}</option>
                ))}
              </select>
            </FormField>
            <FormField label="추출 파일">
              <select className="field-control" name="extract_id">
                <option value="">선택 안 함</option>
                {extracts.map((extract) => (
                  <option key={extract.id} value={extract.id}>
                    {extract.sql_text
                      ? `${extract.filename || extract.table_name} · ${fmtSqlPreview(extract.sql_text)}`
                      : extract.filename || extract.table_name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="소스 커넥션">
              <select
                className="field-control"
                name="connection_id"
                onChange={(event) => {
                  const id = event.target.value;
                  setSourceTables([]);
                  if (!id) return;
                  void api.connectionTables(id).then((result) => setSourceTables(result.tables)).catch(() => undefined);
                }}
              >
                <option value="">선택 안 함</option>
                {connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name} ({connection.driver})
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="소스 테이블">
              <input className="field-control" name="table" list="source-tables" placeholder="public.users" />
              <datalist id="source-tables">
                {sourceTables.map((table) => <option key={table} value={table} />)}
              </datalist>
            </FormField>
          </BuilderSection>

          <BuilderSection index="02" title="변환" description="필요한 컬럼과 행을 선택하고 출력 컬럼명을 정리합니다.">
            <FormField label="선택 컬럼">
              <input className="field-control technical" name="select" placeholder="id, amount" />
            </FormField>
            <FormField label="필터 표현식">
              <input className="field-control technical" name="filter" placeholder="amount > 0" />
            </FormField>
            <FormField label="컬럼명 변경" wide>
              <input className="field-control technical" name="rename" placeholder="amount:amt, id:user_id" />
            </FormField>
          </BuilderSection>

          <BuilderSection index="03" title="적재" description="parquet는 항상 생성됩니다. 대상 커넥션은 선택 사항입니다.">
            <FormField label="대상 커넥션">
              <select
                className="field-control"
                name="dest_connection_id"
                onChange={(event) => {
                  const id = event.target.value;
                  setDestinationTables([]);
                  if (!id) return;
                  void api.connectionTables(id).then((result) => setDestinationTables(result.tables)).catch(() => undefined);
                }}
              >
                <option value="">parquet만 생성</option>
                {connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name} ({connection.driver})
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="대상 테이블">
              <input className="field-control" name="dest_table" list="destination-tables" placeholder="dw.fact" />
              <datalist id="destination-tables">
                {destinationTables.map((table) => <option key={table} value={table} />)}
              </datalist>
            </FormField>
            <FormField label="적재 모드">
              <select className="field-control" name="mode">
                <option value="append">기존 데이터에 추가</option>
                <option value="replace">기존 데이터 교체</option>
              </select>
            </FormField>
          </BuilderSection>

          <div className="flex justify-end bg-raised p-3">
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? "작업 시작 중…" : "작업 생성 및 실행"}
            </Button>
          </div>
        </form>
      </Panel>

      <Panel>
        <Toolbar>
          <ToolbarGroup>
            <span className="text-[13px] font-semibold">실행 이력</span>
            <span className="text-xs text-text-tertiary">{jobs.length}건</span>
          </ToolbarGroup>
        </Toolbar>
        <DataGrid headers={["작업 ID", "상태", "소스", "생성 시각"]}>
          {jobs.length === 0 ? (
            <EmptyGridRow cols={4} text={emptyCopy.queue} />
          ) : (
            jobs.map((job) => (
              <GridRow key={job.id}>
                <GridCell mono>
                  <Link className="font-medium hover:underline" to={`/jobs/${job.id}`}>
                    {job.id.slice(0, 8)}
                  </Link>
                </GridCell>
                <GridCell><StatusPill value={job.status} /></GridCell>
                <GridCell mono muted>{job.source_path}</GridCell>
                <GridCell mono muted>{fmtWhen(job.created_at)}</GridCell>
              </GridRow>
            ))
          )}
        </DataGrid>
      </Panel>
    </PageShell>
  );
}
