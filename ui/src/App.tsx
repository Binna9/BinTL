import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ConsoleRail } from "@/components/ConsoleRail";
import { ConnectionsPage } from "@/pages/ConnectionsPage";
import { ExtractsPage } from "@/pages/ExtractsPage";
import { FilesPage } from "@/pages/FilesPage";
import { JobRunPage } from "@/pages/JobRunPage";
import { JobsPage } from "@/pages/JobsPage";
import { OverviewPage } from "@/pages/OverviewPage";
import { SessionGatePage } from "@/pages/SessionGatePage";

function ConsoleShell() {
  return (
    <div className="grid min-h-screen grid-cols-[13rem_minmax(0,1fr)]">
      <ConsoleRail />
      <main className="min-w-0 p-5">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/files" element={<FilesPage />} />
          <Route path="/connections" element={<ConnectionsPage />} />
          <Route path="/extracts" element={<ExtractsPage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/jobs/:id" element={<JobRunPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  const loc = useLocation();
  if (loc.pathname === "/login") {
    return <SessionGatePage />;
  }
  return <ConsoleShell />;
}
