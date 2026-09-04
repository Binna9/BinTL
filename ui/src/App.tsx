import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useRenderLocation } from "@/hooks/useViewTransitionLocation";
import { BrandMark } from "@/components/BrandMark";
import { ConsoleRail } from "@/layouts/ConsoleRail";
import { HeaderSearch } from "@/components/search/HeaderSearch";
import { SplitLayout } from "@/layouts/SplitLayout";
import { TopSubmenu } from "@/components/TopSubmenu";
import { SessionProvider } from "@/hooks/auth/useSession";
import { cn } from "@/lib/cn";
import { layout } from "@/lib/layout";

const ConnectionsPage = lazy(() => import("@/pages/ConnectionsPage").then((module) => ({ default: module.ConnectionsPage })));
const ExtractResultsPage = lazy(() => import("@/pages/ExtractResultsPage").then((module) => ({ default: module.ExtractResultsPage })));
const ApiExtractPage = lazy(() => import("@/pages/ApiExtractPage").then((module) => ({ default: module.ApiExtractPage })));
const FilesPage = lazy(() => import("@/pages/FilesPage").then((module) => ({ default: module.FilesPage })));
const HistoryPage = lazy(() => import("@/pages/HistoryPage").then((module) => ({ default: module.HistoryPage })));
const JobRunPage = lazy(() => import("@/pages/JobRunPage").then((module) => ({ default: module.JobRunPage })));
const LoadPage = lazy(() => import("@/pages/LoadPage").then((module) => ({ default: module.LoadPage })));
const OverviewPage = lazy(() => import("@/pages/OverviewPage").then((module) => ({ default: module.OverviewPage })));
const QueryPage = lazy(() => import("@/pages/QueryPage").then((module) => ({ default: module.QueryPage })));
const SchedulePage = lazy(() => import("@/pages/SchedulePage").then((module) => ({ default: module.SchedulePage })));
const SessionGatePage = lazy(() => import("@/pages/SessionGatePage").then((module) => ({ default: module.SessionGatePage })));
const TransformFilesPage = lazy(() => import("@/pages/TransformFilesPage").then((module) => ({ default: module.TransformFilesPage })));
const TransformPage = lazy(() => import("@/pages/TransformPage").then((module) => ({ default: module.TransformPage })));
const TransformSoonPage = lazy(() => import("@/pages/TransformSoonPage").then((module) => ({ default: module.TransformSoonPage })));
const WorkspacePage = lazy(() => import("@/pages/WorkspacePage").then((module) => ({ default: module.WorkspacePage })));
const ChipsPage = lazy(() => import("@/pages/ChipsPage").then((module) => ({ default: module.ChipsPage })));
const SearchPage = lazy(() => import("@/pages/SearchPage").then((module) => ({ default: module.SearchPage })));
const WorkspaceRunsPage = lazy(() => import("@/pages/WorkspaceRunsPage").then((module) => ({ default: module.WorkspaceRunsPage })));

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
          <Suspense fallback={null}>
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
              <Route path="/extract/api" element={<ApiExtractPage />} />
              <Route path="/extracts" element={<ExtractResultsPage />} />
              <Route path="/transforms" element={<TransformFilesPage />} />
              <Route path="/transform" element={<Navigate to="/transform/clean" replace />} />
              <Route path="/transform/reshape" element={<TransformSoonPage kind="reshape" />} />
              <Route path="/transform/clean" element={<TransformPage section="clean" />} />
              <Route path="/transform/clean/:id" element={<TransformPage section="clean" />} />
              <Route path="/transform/combine" element={<TransformPage section="combine" />} />
              <Route path="/transform/combine/:id" element={<TransformPage section="combine" />} />
              <Route path="/transform/aggregate" element={<TransformPage section="aggregate" />} />
              <Route path="/transform/aggregate/:id" element={<TransformPage section="aggregate" />} />
              <Route path="/transform/:id" element={<TransformPage />} />
              <Route path="/load" element={<LoadPage />} />
              <Route path="/history" element={<HistoryPage />} />
              <Route path="/jobs" element={<Navigate to="/history" replace />} />
              <Route path="/jobs/:id" element={<JobRunPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </main>
      </SplitLayout>
    </div>
  );
}

export default function App() {
  const loc = useRenderLocation();
  return (
    <SessionProvider>
      {loc.pathname === "/login" ? (
        <Suspense fallback={null}>
          <SessionGatePage />
        </Suspense>
      ) : (
        <ConsoleShell />
      )}
    </SessionProvider>
  );
}
