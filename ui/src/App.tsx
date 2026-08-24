import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ConsoleRail } from "@/components/ConsoleRail";
import { TopSubmenu } from "@/components/TopSubmenu";
import { ConnectionsPage } from "@/pages/ConnectionsPage";
import { ExtractsPage } from "@/pages/ExtractsPage";
import { FilesPage } from "@/pages/FilesPage";
import { JobRunPage } from "@/pages/JobRunPage";
import { JobsPage } from "@/pages/JobsPage";
import { OverviewPage } from "@/pages/OverviewPage";
import { QueryPage } from "@/pages/QueryPage";
import { SessionGatePage } from "@/pages/SessionGatePage";

function ConsoleShell() {
  return (
    <div className="grid min-h-screen grid-cols-[13rem_minmax(0,1fr)]">
      <ConsoleRail />
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-end border-b border-border bg-surface px-5">
          <TopSubmenu />
        </header>
        <main className="min-w-0 flex-1 p-5">
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/files" element={<FilesPage />} />
            <Route path="/connections" element={<ConnectionsPage />} />
            <Route path="/query" element={<QueryPage />} />
            <Route path="/extracts" element={<ExtractsPage />} />
            <Route path="/jobs" element={<JobsPage />} />
            <Route path="/jobs/:id" element={<JobRunPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
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
