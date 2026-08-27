import { Link } from "react-router-dom";
import { Cable, ChevronRight, FolderOpen, Upload } from "lucide-react";
import { PanelBody } from "@/components/ui/panel";
import { useLanguage } from "@/i18n/LanguageProvider";

export function StartWidget() {
  const { messages } = useLanguage();

  return (
    <PanelBody className="flex h-full min-h-0 flex-col gap-2.5">
      <Link to="/files" className="dash-start flex-1">
        <span className="dash-start-icon">
          <Upload className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold text-text">{messages.overview.startUpload}</span>
          <span className="mt-0.5 block text-[11px] text-text-secondary">{messages.overview.startUploadHint}</span>
        </span>
        <ChevronRight className="size-4 text-text-tertiary" />
      </Link>
      <Link to="/workspace" className="dash-start flex-1">
        <span className="dash-start-icon">
          <FolderOpen className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold text-text">{messages.overview.startWorkspace}</span>
          <span className="mt-0.5 block text-[11px] text-text-secondary">{messages.overview.startWorkspaceHint}</span>
        </span>
        <ChevronRight className="size-4 text-text-tertiary" />
      </Link>
      <Link to="/connections" className="dash-start flex-1">
        <span className="dash-start-icon">
          <Cable className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold text-text">{messages.overview.startConnection}</span>
          <span className="mt-0.5 block text-[11px] text-text-secondary">{messages.overview.startConnectionHint}</span>
        </span>
        <ChevronRight className="size-4 text-text-tertiary" />
      </Link>
    </PanelBody>
  );
}
