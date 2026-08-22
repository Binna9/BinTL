import { Link, NavLink, Navigate, Route, Routes } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import Files from "./pages/Files";
import JobDetail from "./pages/JobDetail";
import Jobs from "./pages/Jobs";
import Login from "./pages/Login";
import { api } from "./api";

export default function App() {
  return (
    <>
      <nav>
        <Link to="/">BinTL</Link>
        <NavLink to="/">dashboard</NavLink>
        <NavLink to="/files">files</NavLink>
        <NavLink to="/jobs">jobs</NavLink>
        <button
          type="button"
          onClick={() => {
            void api.logout().finally(() => location.assign("/login"));
          }}
        >
          logout
        </button>
      </nav>
      <main>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Dashboard />} />
          <Route path="/files" element={<Files />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/jobs/:id" element={<JobDetail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  );
}
