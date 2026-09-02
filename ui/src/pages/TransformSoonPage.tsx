import { PageHeader, PageShell } from "@/layouts/PageShell";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { useLanguage } from "@/i18n/LanguageProvider";

export type TransformSoonKind = "combine" | "aggregate" | "reshape";

export function TransformSoonPage({ kind }: { kind: TransformSoonKind }) {
  const { messages } = useLanguage();
  const copy = {
    combine: {
      title: messages.transform.combineTitle,
      description: messages.transform.combineDescription,
      hint: messages.transform.combineHint,
    },
    aggregate: {
      title: messages.transform.aggregateTitle,
      description: messages.transform.aggregateDescription,
      hint: messages.transform.aggregateHint,
    },
    reshape: {
      title: messages.transform.reshapeTitle,
      description: messages.transform.reshapeDescription,
      hint: messages.transform.reshapeHint,
    },
  }[kind];

  return (
    <PageShell>
      <PageHeader
        iconName="jobs"
        eyebrow={messages.transform.eyebrow}
        title={copy.title}
        description={copy.description}
      />
      <Panel tall>
        <PanelHeader title={messages.transform.soonPending} />
        <PanelBody className="min-h-0 flex-1">
          <p className="text-sm leading-6 text-text-secondary">{copy.hint}</p>
        </PanelBody>
      </Panel>
    </PageShell>
  );
}
