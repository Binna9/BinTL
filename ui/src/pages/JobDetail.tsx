import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, JobDetail as Detail, resultUrl } from "../api";

export default function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<Detail | null>(null);
  const [error, setError] = useState("");

  async function refresh() {
    if (!id) return;
    setJob(await api.job(id));
  }

  useEffect(() => {
    void refresh().catch((err) =>
      setError(err instanceof Error ? err.message : "load failed"),
    );
    const t = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 1500);
    return () => clearInterval(t);
  }, [id]);

  async function run() {
    if (!id) return;
    setError("");
    try {
      await api.runJob(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "run failed");
    }
  }

  if (!job) {
    return error ? <p className="error">{error}</p> : <p>loading…</p>;
  }

  return (
    <div>
      <p>
        <Link to="/jobs">← jobs</Link>
      </p>
      <h1>Job {job.id.slice(0, 8)}</h1>
      <p className="status">{job.status}</p>
      <p>source: {job.source_path}</p>
      <p>output: {job.output_path ?? "—"}</p>
      {job.error_message ? <p className="error">{job.error_message}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      <p>
        <button type="button" onClick={() => void run()} disabled={job.status === "running"}>
          run
        </button>{" "}
        {job.status === "succeeded" ? (
          <a href={resultUrl(job.id)}>download result</a>
        ) : null}
      </p>
      <h2>Logs</h2>
      <pre>
        {job.logs
          .map((l) => `${l.ts} [${l.level}] ${l.message}`)
          .join("\n") || "(empty)"}
      </pre>
    </div>
  );
}
