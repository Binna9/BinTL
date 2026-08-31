import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { useRenderLocation } from "@/hooks/useViewTransitionLocation";
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
import { TransformFilesPage } from "@/pages/TransformFilesPage";
import { CombinePage } from "@/pages/CombinePage";
import { TransformPage } from "@/pages/TransformPage";
import { TransformSoonPage } from "@/pages/TransformSoonPage";
import { WorkspacePage } from "@/pages/WorkspacePage";
import { ChipsPage } from "@/pages/ChipsPage";
import { SearchPage } from "@/pages/SearchPage";
import { WorkspaceRunsPage } from "@/pages/WorkspaceRunsPage";
import { SessionProvider } from "@/hooks/useSession";
import { cn } from "@/lib/cn";
import { layout } from "@/lib/layout";

function LegacyTransformRedirect() {
  const { id } = useParams();
  return <Navigate to={id ? `/transform/clean/${id}` : "/transform/clean"} replace />;
}

function ConsoleShell() {
  const loc = useRenderLocation();
  const onSearchPage = loc.pathname === "/search";
  const studio =
    !onSearchPage &&
    (loc.pathname === "/workspace" ||
      (loc.pathname.startsWith("/workspace/") && !loc.pathname.startsWith("/workspace/runs")));
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
        <ConsoleRail inactive={onSearchPage} />
        <main
          className={cn(
            "min-h-0 min-w-0 flex-1",
            onSearchPage ? "overflow-hidden" : studio ? "overflow-hidden" : "overflow-y-auto p-4",
          )}
        >
          <Routes location={loc}>
            <Route path="/search" element={<SearchPage />} />
            <Route path="/" element={<OverviewPage />} />
            <Route path="/files" element={<FilesPage />} />
            <Route path="/connections" element={<ConnectionsPage />} />
            <Route path="/schedule" element={<SchedulePage />} />
            <Route path="/workspace/runs" element={<WorkspaceRunsPage />} />
            <Route path="/workspace" element={<WorkspacePage />} />
            <Route path="/workspace/:workspaceId" element={<WorkspacePage />} />
            <Route path="/workspace/:workspaceId/chips/:chipId" element={<WorkspacePage />} />
            <Route path="/chips" element={<ChipsPage />} />
            <Route path="/workspace/:workspaceId/tasks/:taskId" element={<Navigate to={loc.pathname.replace("/tasks/", "/chips/")} replace />} />
            <Route path="/db" element={<QueryPage />} />
            <Route path="/query" element={<QueryPage />} />
            <Route path="/extracts" element={<ExtractResultsPage />} />
            <Route path="/transforms" element={<TransformFilesPage />} />
            <Route path="/transform" element={<Navigate to="/transform/clean" replace />} />
            <Route path="/transform/clean" element={<TransformPage />} />
            <Route path="/transform/clean/:id" element={<TransformPage />} />
            <Route path="/transform/combine" element={<CombinePage />} />
            <Route path="/transform/combine/:id" element={<CombinePage />} />
            <Route path="/transform/aggregate" element={<TransformSoonPage kind="aggregate" />} />
            <Route path="/transform/reshape" element={<TransformSoonPage kind="reshape" />} />
            <Route path="/transform/:id" element={<LegacyTransformRedirect />} />
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
  const loc = useRenderLocation();
  return (
    <SessionProvider>
      {loc.pathname === "/login" ? <SessionGatePage /> : <ConsoleShell />}
    </SessionProvider>
  );
}
