import { FormEvent, useEffect, useState } from "react";
import { api, FileItem } from "../api";

export default function Files() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const res = await api.files();
    setFiles(res.files);
  }

  useEffect(() => {
    void refresh().catch((err) =>
      setError(err instanceof Error ? err.message : "load failed"),
    );
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const input = e.currentTarget.elements.namedItem("file") as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      await api.upload(file);
      input.value = "";
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Files</h1>
      <form onSubmit={(e) => void onSubmit(e)}>
        <input name="file" type="file" />
        <button type="submit" disabled={busy}>
          upload
        </button>
      </form>
      {error ? <p className="error">{error}</p> : null}
      <table>
        <thead>
          <tr>
            <th>id</th>
            <th>filename</th>
            <th>size</th>
            <th>path</th>
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr key={`${f.id}-${f.filename}`}>
              <td>{f.id.slice(0, 8)}</td>
              <td>{f.filename}</td>
              <td>{f.size}</td>
              <td>{f.stored_path}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
