import { FormEvent, ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { DataGrid, EmptyGridRow, GridCell, GridRow } from "@/components/DataGrid";
import { PageHeader, PageShell } from "@/components/PageShell";
import { SplitLayout } from "@/components/SplitLayout";
import { StatusPill } from "@/components/StatusPill";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { NoticeBanner } from "@/components/ui/notice-banner";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { useJobWorkspace } from "@/hooks/useJobWorkspace";
import { useLanguage } from "@/i18n/LanguageProvider";
import { fmtSqlPreview, fmtWhen } from "@/lib/format";
import { layout } from "@/lib/layout";
import { connectionApi } from "@/services/connectionApi";
import { jobApi } from "@/services/jobApi";

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
  const { messages } = useLanguage();
  const {
    jobs,
    files,
    extracts,
    connections,
    workspaceError,
    setWorkspaceError,
    refreshJobWorkspace,
  } = useJobWorkspace();
  const [sourceTables, setSourceTables] = useState<string[]>([]);
  const [destinationTables, setDestinationTables] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

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

    setWorkspaceError("");
    setBusy(true);
    try {
      const job = await jobApi.createJob({
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
      await jobApi.runJob(job.id);
      await refreshJobWorkspace();
    } catch (err) {
      setWorkspaceError(err instanceof Error ? err.message : messages.errors.createJob);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell>
      <PageHeader
        iconName="jobs"
        eyebrow={messages.jobs.eyebrow}
        title={messages.jobs.title}
        description={messages.jobs.description}
      />
      {workspaceError ? <NoticeBanner>{workspaceError}</NoticeBanner> : null}

      <Panel>
        <PanelHeader title={messages.jobs.definition} description={messages.jobs.definitionDescription} />
        <form onSubmit={(event) => void onSubmit(event)}>
          <BuilderSection index="01" title={messages.jobs.source} description={messages.jobs.sourceDescription}>
            <FormField label={messages.jobs.uploadFile}>
              <select className="field-control" name="file_id">
                <option value="">{messages.jobs.none}</option>
                {files.map((file) => (
                  <option key={file.id} value={file.id}>{file.filename}</option>
                ))}
              </select>
            </FormField>
            <FormField label={messages.jobs.extractFile}>
              <select className="field-control" name="extract_id">
                <option value="">{messages.jobs.none}</option>
                {extracts.map((extract) => (
                  <option key={extract.id} value={extract.id}>
                    {extract.sql_text
                      ? `${extract.filename || extract.table_name} · ${fmtSqlPreview(extract.sql_text)}`
                      : extract.filename || extract.table_name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label={messages.jobs.sourceConnection}>
              <select
                className="field-control"
                name="connection_id"
                onChange={(event) => {
                  const id = event.target.value;
                  setSourceTables([]);
                  if (!id) return;
                  void connectionApi
                    .getTables(id)
                    .then((result) => setSourceTables(result.tables))
                    .catch(() => undefined);
                }}
              >
                <option value="">{messages.jobs.none}</option>
                {connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name} ({connection.driver})
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label={messages.jobs.sourceTable}>
              <input className="field-control" name="table" list="source-tables" placeholder="public.users" />
              <datalist id="source-tables">
                {sourceTables.map((table) => <option key={table} value={table} />)}
              </datalist>
            </FormField>
          </BuilderSection>

          <BuilderSection index="02" title={messages.jobs.transform} description={messages.jobs.transformDescription}>
            <FormField label={messages.jobs.selectedColumns}>
              <input className="field-control technical" name="select" placeholder="id, amount" />
            </FormField>
            <FormField label={messages.jobs.filter}>
              <input className="field-control technical" name="filter" placeholder="amount > 0" />
            </FormField>
            <FormField label={messages.jobs.rename} wide>
              <input className="field-control technical" name="rename" placeholder="amount:amt, id:user_id" />
            </FormField>
          </BuilderSection>

          <BuilderSection index="03" title={messages.jobs.load} description={messages.jobs.loadDescription}>
            <FormField label={messages.jobs.destinationConnection}>
              <select
                className="field-control"
                name="dest_connection_id"
                onChange={(event) => {
                  const id = event.target.value;
                  setDestinationTables([]);
                  if (!id) return;
                  void connectionApi
                    .getTables(id)
                    .then((result) => setDestinationTables(result.tables))
                    .catch(() => undefined);
                }}
              >
                <option value="">{messages.jobs.parquetOnly}</option>
                {connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name} ({connection.driver})
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label={messages.jobs.destinationTable}>
              <input className="field-control" name="dest_table" list="destination-tables" placeholder="dw.fact" />
              <datalist id="destination-tables">
                {destinationTables.map((table) => <option key={table} value={table} />)}
              </datalist>
            </FormField>
            <FormField label={messages.jobs.mode}>
              <select className="field-control" name="mode">
                <option value="append">{messages.jobs.append}</option>
                <option value="replace">{messages.jobs.replace}</option>
              </select>
            </FormField>
          </BuilderSection>

          <div className="flex justify-end bg-raised p-3">
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? messages.jobs.starting : messages.jobs.createAndRun}
            </Button>
          </div>
        </form>
      </Panel>

      <Panel>
        <Toolbar>
          <ToolbarGroup>
            <span className="text-[13px] font-semibold">{messages.jobs.history}</span>
            <span className="text-xs text-text-tertiary">{messages.common.cases(jobs.length)}</span>
          </ToolbarGroup>
        </Toolbar>
        <DataGrid headers={[...messages.jobs.headers]}>
          {jobs.length === 0 ? (
            <EmptyGridRow cols={4} text={messages.empty.queue} />
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
