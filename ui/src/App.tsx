import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { BrandMark } from "@/components/BrandMark";
import { ConsoleRail } from "@/components/ConsoleRail";
import { SplitLayout } from "@/components/SplitLayout";
import { TopSubmenu } from "@/components/TopSubmenu";
import { ConnectionsPage } from "@/pages/ConnectionsPage";
import { ExtractResultsPage } from "@/pages/ExtractResultsPage";
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
      <header className="sticky top-0 z-40 flex h-[4.75rem] shrink-0 items-center justify-between border-b border-border bg-surface px-5 shadow-[0_2px_5px_rgba(15,23,42,0.06)] dark:shadow-[0_2px_6px_rgba(0,0,0,0.28)]">
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
        <main className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto p-5">
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/files" element={<FilesPage />} />
            <Route path="/connections" element={<ConnectionsPage />} />
            <Route path="/db" element={<QueryPage />} />
            <Route path="/query" element={<QueryPage />} />
            <Route path="/extracts" element={<ExtractResultsPage />} />
            <Route path="/jobs" element={<JobsPage />} />
            <Route path="/transform" element={<JobsPage />} />
            <Route path="/load" element={<JobsPage />} />
            <Route path="/history" element={<JobsPage />} />
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
