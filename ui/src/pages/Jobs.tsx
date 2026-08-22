import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, FileItem, Job } from "../api";

export default function Jobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [error, setError] = useState("");

  async function refresh() {
    const [j, f] = await Promise.all([api.jobs(50), api.files()]);
    setJobs(j.jobs);
    setFiles(f.files);
  }

  useEffect(() => {
    void refresh().catch((err) =>
      setError(err instanceof Error ? err.message : "load failed"),
    );
  }, []);

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const select = e.currentTarget.elements.namedItem("file_id") as HTMLSelectElement;
    if (!select.value) return;
    setError("");
    try {
      const job = await api.createJob(select.value);
      await api.runJob(job.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
    }
  }

  return (
    <div>
      <h1>Jobs</h1>
      <form onSubmit={(e) => void onCreate(e)}>
        <label>
          file
          <select name="file_id">
            {files.map((f) => (
              <option key={f.id} value={f.id}>
                {f.filename} ({f.id.slice(0, 8)})
              </option>
            ))}
          </select>
        </label>{" "}
        <button type="submit" disabled={files.length === 0}>
          create + run identity
        </button>
      </form>
      {error ? <p className="error">{error}</p> : null}
      <table>
        <thead>
          <tr>
            <th>id</th>
            <th>status</th>
            <th>source</th>
            <th>created</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>
                <Link to={`/jobs/${job.id}`}>{job.id.slice(0, 8)}</Link>
              </td>
              <td className="status">{job.status}</td>
              <td>{job.source_path}</td>
              <td>{job.created_at}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
