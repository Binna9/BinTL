import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";

export default function Login() {
  const nav = useNavigate();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("admin");
  const [error, setError] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await api.login(username, password);
      nav("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)}>
      <h1>Login</h1>
      <p>
        <label>
          username
          <br />
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
      </p>
      <p>
        <label>
          password
          <br />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
      </p>
      {error ? <p className="error">{error}</p> : null}
      <button type="submit">sign in</button>
    </form>
  );
}
