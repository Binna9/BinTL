import { PageHeader, PageShell } from "@/components/PageShell";
import { ReleaseBadge } from "@/components/ReleaseBadge";
import {
  ClosedWidgetBar,
  DashboardBoard,
  DashboardProvider,
  WidgetPalette,
} from "@/dashboard";
import { useLanguage } from "@/i18n/LanguageProvider";

function OverviewHeader() {
  const { messages } = useLanguage();
  return (
    <PageHeader
      iconName="overview"
      eyebrow={messages.overview.eyebrow}
      title={messages.overview.title}
      description={messages.overview.description}
      actions={
        <div className="flex items-center gap-3">
          <WidgetPalette />
          <ReleaseBadge />
        </div>
      }
    />
  );
}

function OverviewCanvas() {
  const { messages } = useLanguage();
  return (
    <section className="dash-canvas flex flex-col" aria-label={messages.overview.canvasAria}>
      <div className="dash-canvas-wash" aria-hidden="true" />
      <div className="relative flex min-h-[calc(100vh-12.5rem)] flex-1 flex-col gap-3 p-3">
        <ClosedWidgetBar />
        <div className="flex min-h-0 flex-1 flex-col">
          <DashboardBoard />
        </div>
      </div>
    </section>
  );
}

export function OverviewPage() {
  return (
    <DashboardProvider>
      <PageShell>
        <OverviewHeader />
        <OverviewCanvas />
      </PageShell>
    </DashboardProvider>
  );
}
