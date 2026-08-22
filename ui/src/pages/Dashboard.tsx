import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, Health, Job } from "../api";

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const [h, j] = await Promise.all([api.health(), api.jobs(10)]);
        setHealth(h);
        setJobs(j.jobs);
      } catch (err) {
        setError(err instanceof Error ? err.message : "load failed");
      }
    })();
  }, []);

  return (
    <div>
      <h1>Dashboard</h1>
      {health ? (
        <p>
          health ok={String(health.ok)} version={health.version}
        </p>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      <h2>Recent jobs</h2>
      <table>
        <thead>
          <tr>
            <th>id</th>
            <th>status</th>
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
              <td>{job.created_at}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
