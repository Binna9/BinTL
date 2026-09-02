import { PageHeader, PageShell } from "@/layouts/PageShell";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { useLanguage } from "@/i18n/LanguageProvider";

export function SchedulePage() {
  const { messages } = useLanguage();
  return (
    <PageShell>
      <PageHeader
        iconName="schedule"
        eyebrow={messages.schedule.eyebrow}
        title={messages.schedule.title}
        description={messages.schedule.description}
      />
      <Panel tall>
        <PanelHeader title={messages.schedule.pending} />
        <PanelBody className="min-h-0 flex-1">
          <p className="text-sm leading-6 text-text-secondary">{messages.schedule.hint}</p>
        </PanelBody>
      </Panel>
    </PageShell>
  );
}
