import { PageHeader, PageShell } from "@/layouts/PageShell";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { useLanguage } from "@/i18n/LanguageProvider";

export function LoadPage() {
  const { messages } = useLanguage();
  return (
    <PageShell>
      <PageHeader
        iconName="jobs"
        eyebrow={messages.load.eyebrow}
        title={messages.load.title}
        description={messages.load.description}
      />
      <Panel tall>
        <PanelHeader title={messages.load.pending} />
        <PanelBody className="min-h-0 flex-1">
          <p className="text-sm leading-6 text-text-secondary">{messages.load.hint}</p>
        </PanelBody>
      </Panel>
    </PageShell>
  );
}
