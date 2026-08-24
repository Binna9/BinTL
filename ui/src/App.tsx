import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { BrandMark } from "@/components/BrandMark";
import { ConsoleRail } from "@/components/ConsoleRail";
import { SplitLayout } from "@/components/SplitLayout";
import { TopSubmenu } from "@/components/TopSubmenu";
import { ConnectionsPage } from "@/pages/ConnectionsPage";
import { ExtractsPage } from "@/pages/ExtractsPage";
import { FilesPage } from "@/pages/FilesPage";
import { JobRunPage } from "@/pages/JobRunPage";
import { JobsPage } from "@/pages/JobsPage";
import { OverviewPage } from "@/pages/OverviewPage";
import { QueryPage } from "@/pages/QueryPage";
import { SessionGatePage } from "@/pages/SessionGatePage";
import { layout } from "@/lib/layout";

function ConsoleShell() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="app-header sticky top-0 z-40 flex h-[4.75rem] shrink-0 items-center justify-between bg-surface px-5">
        <BrandMark to="/" />
        <TopSubmenu />
      </header>
      <SplitLayout
        className="min-h-0 flex-1"
        defaultSizes={[layout.split.nav]}
        minSize={layout.split.minNav}
        maxSize={layout.split.maxNav}
      >
        <ConsoleRail />
        <main className="min-w-0 p-5">
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
      </SplitLayout>
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
