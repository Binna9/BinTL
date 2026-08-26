import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { BrandMark } from "@/components/BrandMark";
import { ConsoleRail } from "@/components/ConsoleRail";
import { HeaderSearch } from "@/components/HeaderSearch";
import { SplitLayout } from "@/components/SplitLayout";
import { TopSubmenu } from "@/components/TopSubmenu";
import { ConnectionsPage } from "@/pages/ConnectionsPage";
import { ExtractResultsPage } from "@/pages/ExtractResultsPage";
import { FilesPage } from "@/pages/FilesPage";
import { HistoryPage } from "@/pages/HistoryPage";
import { JobRunPage } from "@/pages/JobRunPage";
import { LoadPage } from "@/pages/LoadPage";
import { OverviewPage } from "@/pages/OverviewPage";
import { QueryPage } from "@/pages/QueryPage";
import { SchedulePage } from "@/pages/SchedulePage";
import { SessionGatePage } from "@/pages/SessionGatePage";
import { TransformPage } from "@/pages/TransformPage";
import { WorkspacePage } from "@/pages/WorkspacePage";
import { layout } from "@/lib/layout";
import { cn } from "@/lib/cn";

function ConsoleShell() {
  const loc = useLocation();
  const studio = loc.pathname.startsWith("/workspace");
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="sticky top-0 z-40 grid h-[4.75rem] shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-border bg-surface px-5 shadow-[0_2px_5px_rgba(15,23,42,0.06)] dark:shadow-[0_2px_6px_rgba(0,0,0,0.28)]">
        <BrandMark to="/" />
        <HeaderSearch />
        <div className="justify-self-end">
          <TopSubmenu />
        </div>
      </header>
      <SplitLayout
        className="min-h-0 flex-1"
        defaultSizes={[layout.split.nav]}
        minSize={layout.split.minNav}
        maxSize={layout.split.maxNav}
      >
        <ConsoleRail />
        <main
          className={cn(
            "min-h-0 min-w-0 flex-1",
            studio ? "overflow-hidden" : "overflow-y-auto p-4",
          )}
        >
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/files" element={<FilesPage />} />
            <Route path="/connections" element={<ConnectionsPage />} />
            <Route path="/schedule" element={<SchedulePage />} />
            <Route path="/workspace" element={<WorkspacePage />} />
            <Route path="/workspace/:workspaceId" element={<WorkspacePage />} />
            <Route path="/workspace/:workspaceId/tasks/:taskId" element={<WorkspacePage />} />
            <Route path="/db" element={<QueryPage />} />
            <Route path="/query" element={<QueryPage />} />
            <Route path="/extracts" element={<ExtractResultsPage />} />
            <Route path="/transform" element={<TransformPage />} />
            <Route path="/transform/:id" element={<TransformPage />} />
            <Route path="/load" element={<LoadPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/jobs" element={<Navigate to="/history" replace />} />
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
